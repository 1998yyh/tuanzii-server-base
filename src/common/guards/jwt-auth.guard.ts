import { ExecutionContext, Injectable, Optional, UnauthorizedException } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ConfigService } from '@nestjs/config';
import { BrowserSessionsService } from '../../auth/browser-sessions.service';
import type { SessionRequest } from '../../auth/browser-sessions.service';

@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  constructor(
    @Optional() private readonly sessions?: BrowserSessionsService,
    @Optional() private readonly config?: ConfigService,
  ) {
    super();
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<SessionRequest>();
    // 明确提供 Bearer 时只按旧协议验证，不回退到 Cookie，避免凭据歧义和降级。
    if (
      request.headers.authorization !== undefined ||
      !this.sessions?.enabled ||
      !this.sessions.token(request)
    ) {
      if (this.config?.get('LEGACY_JWT_ENABLED') === 'false')
        throw new UnauthorizedException('请通过统一登录入口登录');
      return (await super.canActivate(context)) as boolean;
    }
    await this.sessions.authenticate(request);
    this.sessions.observe(request, context.switchToHttp().getResponse());
    return true;
  }
  /**
   * 统一鉴权失败文案（token 缺失/过期/验签失败时 passport 默认抛英文 "Unauthorized"，
   * 与全站中文错误约定不一致，这里统一转成中文）。
   */
  handleRequest<TUser = unknown>(err: unknown, user: TUser): TUser {
    if (err || !user) {
      throw err instanceof UnauthorizedException
        ? err
        : new UnauthorizedException('登录状态已失效，请重新登录');
    }
    return user;
  }
}
