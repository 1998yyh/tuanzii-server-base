import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  PayloadTooLargeException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, timingSafeEqual } from 'node:crypto';
import { BlockList, isIP } from 'node:net';
import { Request } from 'express';

const localNetworks = new BlockList();
localNetworks.addSubnet('127.0.0.0', 8, 'ipv4');
localNetworks.addSubnet('10.0.0.0', 8, 'ipv4');
localNetworks.addSubnet('172.16.0.0', 12, 'ipv4');
localNetworks.addSubnet('192.168.0.0', 16, 'ipv4');
localNetworks.addAddress('::1', 'ipv6');
localNetworks.addSubnet('fc00::', 7, 'ipv6');

@Injectable()
export class XiaofeiyuDiaryWebhookGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const expected = this.config.get<string>('XIAOFEIYU_WEBHOOK_KEY');
    if (!expected || expected.length < 32 || expected.length > 256) {
      // 未配置时仅关闭收信入口，不阻止共享后台其他模块启动。
      throw new ServiceUnavailableException('日记推送尚未配置');
    }
    const request = context.switchToHttp().getRequest<Request>();
    // 容器会看到宿主机的 Docker 私网地址；不信任转发头声明的“本机身份”。
    // 所有公网 Nginx 入口均添加这些头，因此即使从其他应用的 API 别名绕入也拒绝。
    const address = (request.socket.remoteAddress || '').replace(/^::ffff:/, '');
    const family = isIP(address);
    if (
      !family ||
      !localNetworks.check(address, family === 6 ? 'ipv6' : 'ipv4') ||
      ['x-forwarded-for', 'forwarded', 'x-real-ip'].some(
        (name) => request.headers[name] !== undefined,
      )
    ) {
      throw new ForbiddenException('日记推送仅允许服务器本机直连');
    }
    const declaredSize = Number(request.headers['content-length'] || 0);
    if (declaredSize > 262144 || Buffer.byteLength(JSON.stringify(request.body ?? {})) > 262144) {
      throw new PayloadTooLargeException('日记推送不能超过256KB');
    }
    const supplied = request.headers['x-xiaofeiyu-key'] ?? request.query.key;
    if (typeof supplied !== 'string' || supplied.length > 256) {
      throw new ForbiddenException('日记推送验证失败');
    }
    const digest = (value: string) => createHash('sha256').update(value).digest();
    if (!timingSafeEqual(digest(supplied), digest(expected))) {
      throw new ForbiddenException('日记推送验证失败');
    }
    return true;
  }
}
