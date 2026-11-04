import {
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, IsNull, LessThan, MoreThan, Repository } from 'typeorm';
import { Cron } from '@nestjs/schedule';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import * as bcrypt from 'bcrypt';
import type { Request, Response } from 'express';
import { UsersService } from '../users/users.service';
import { User, UserRole } from '../users/users.entity';
import { BrowserSession, UserAppGrant } from './browser-session.entity';
import { CreateBrowserSessionDto } from './browser-session.dto';

export interface SessionRequest extends Request {
  user?: Omit<User, 'password'>;
  browserSession?: BrowserSession;
}
const DAY = 86_400_000;
const DUMMY_HASH = '$2b$10$YYo503REnYg5NGfUrz5W3edfSizhrFGPF1/3AZVMcUgYfr7AiOEsq';
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
export const hashSessionToken = (value: string) => createHash('sha256').update(value).digest('hex');
const equalSecret = (a: string, b: string) => {
  const left = Buffer.from(a),
    right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};

@Injectable()
export class BrowserSessionsService {
  readonly enabled: boolean;
  readonly origin: string;
  readonly cookieName: string;
  private readonly secure: boolean;
  private readonly csrfKey: string;
  private readonly attempts = new Map<string, { count: number; until: number }>();
  private readonly connections = new Map<string, Set<Response>>();

  constructor(
    @InjectRepository(BrowserSession) private readonly sessions: Repository<BrowserSession>,
    @InjectRepository(UserAppGrant) private readonly grants: Repository<UserAppGrant>,
    private readonly users: UsersService,
    private readonly database: DataSource,
    config: ConfigService,
  ) {
    this.enabled = config.get('WEB_SESSION_ENABLED') === 'true';
    this.origin = config.get<string>('AUTH_ORIGIN', '');
    this.csrfKey = config.get<string>('AUTH_CSRF_SECRET', '');
    this.secure = true;
    this.cookieName = '__Host-tuanzi_session';
    if (!this.enabled) return;
    let origin: URL;
    try {
      origin = new URL(this.origin);
    } catch {
      throw new Error('AUTH_ORIGIN 必须配置为完整的 HTTPS 来源');
    }
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname);
    if (
      origin.origin !== this.origin ||
      origin.username ||
      origin.password ||
      !['http:', 'https:'].includes(origin.protocol)
    )
      throw new Error('AUTH_ORIGIN 只能包含协议、主机和端口');
    if (origin.protocol !== 'https:') {
      if (
        config.get('NODE_ENV') === 'production' ||
        !local ||
        config.get('WEB_SESSION_ALLOW_LOCAL_HTTP') !== 'true'
      )
        throw new Error('统一登录必须使用 HTTPS；本机调试例外需显式开启');
      this.secure = false;
      this.cookieName = 'tuanzi_dev_session';
    }
    if (!/^[a-f0-9]{64}$/i.test(this.csrfKey))
      throw new Error('AUTH_CSRF_SECRET 必须为独立的 64 位十六进制密钥');
  }

  private ready() {
    if (!this.enabled) throw new ServiceUnavailableException('统一登录尚未启用');
  }

  token(request: Request): string | undefined {
    const matches = (request.headers.cookie ?? '')
      .split(';')
      .map((part) => part.trim())
      .filter((part) => part.startsWith(this.cookieName + '='));
    if (matches.length !== 1) return undefined;
    const token = matches[0].slice(this.cookieName.length + 1);
    return /^[A-Za-z0-9_-]{43}$/.test(token) ? token : undefined;
  }

  private csrf(session: BrowserSession) {
    return createHmac('sha256', Buffer.from(this.csrfKey, 'hex'))
      .update(`csrf:${session.id}:${session.authVersion}`)
      .digest('base64url');
  }

  assertSource(request: Request, login = false) {
    this.ready();
    const unsafe = !SAFE_METHODS.has(request.method.toUpperCase());
    if (request.headers.origin && request.headers.origin !== this.origin)
      throw new ForbiddenException('请求来源不受信任');
    if (request.headers['sec-fetch-site'] === 'cross-site')
      throw new ForbiddenException('不接受跨站请求');
    if (unsafe && request.headers.origin !== this.origin)
      throw new ForbiddenException('写操作必须来自本站');
    if (login && (request.headers['x-tuanzi-csrf'] !== 'login' || !request.is('application/json')))
      throw new ForbiddenException('登录请求格式无效');
  }

  private rateLimit(request: Request, account: string) {
    const remote = request.socket.remoteAddress ?? '';
    const proxy = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote);
    const forwarded = request.headers['x-real-ip'];
    const ip = proxy && typeof forwarded === 'string' && isIP(forwarded) ? forwarded : remote;
    const now = Date.now();
    for (const [key, entry] of this.attempts) if (entry.until <= now) this.attempts.delete(key);
    for (const [key, limit] of [
      [hashSessionToken(`ip:${ip}`), 30],
      [hashSessionToken(`account:${account.toLowerCase()}`), 10],
    ] as const) {
      const previous = this.attempts.get(key) ?? { count: 0, until: now + 300_000 };
      if (++previous.count > limit || this.attempts.size > 10_000)
        throw new HttpException('登录尝试过于频繁，请稍后重试', HttpStatus.TOO_MANY_REQUESTS);
      this.attempts.set(key, previous);
    }
  }

  async create(dto: CreateBrowserSessionDto, request: Request, response: Response) {
    this.assertSource(request, true);
    const login = dto.login.trim();
    this.rateLimit(request, login);
    const user = (await this.users.findByEmail(login)) ?? (await this.users.findByUsername(login));
    if (!user) {
      await bcrypt.compare(dto.password, DUMMY_HASH);
      throw new UnauthorizedException('用户名或密码错误');
    }
    if (!(await this.users.validatePassword(dto.password, user.password)))
      throw new UnauthorizedException('用户名或密码错误');
    const token = randomBytes(32).toString('base64url');
    const now = new Date();
    const session = await this.database.transaction(async (manager) => {
      // 与退出全部设备串行化：登录不得在全局撤销之后插入一个旧认证版本的有效会话。
      const current = await manager.findOne(User, {
        where: { id: user.id },
        lock: { mode: 'pessimistic_write' },
      });
      if (!current || current.password !== user.password)
        throw new UnauthorizedException('账号状态已变化，请重新登录');
      const old = this.token(request);
      if (old)
        await manager.update(
          BrowserSession,
          { tokenHash: hashSessionToken(old), revokedAt: IsNull() },
          { revokedAt: now },
        );
      return manager.save(
        BrowserSession,
        manager.create(BrowserSession, {
          userId: current.id,
          authVersion: current.authVersion ?? 0,
          tokenHash: hashSessionToken(token),
          remembered: dto.remember === true,
          userAgent: (request.get('user-agent') ?? '未知设备')
            .split('')
            .filter((char) => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127)
            .join('')
            .slice(0, 180),
          lastSeenAt: now,
          expiresAt: new Date(now.getTime() + (dto.remember ? 7 * DAY : 12 * 3_600_000)),
          revokedAt: null,
        }),
      );
    });
    response.cookie(this.cookieName, token, {
      httpOnly: true,
      secure: this.secure,
      sameSite: 'lax',
      path: '/',
      ...(dto.remember ? { maxAge: 7 * DAY } : {}),
    });
    return this.view(session, user);
  }

  async authenticate(request: SessionRequest, touch = true) {
    this.assertSource(request);
    const token = this.token(request);
    if (!token) throw new UnauthorizedException('请登录后继续');
    const session = await this.sessions.findOne({ where: { tokenHash: hashSessionToken(token) } });
    const now = Date.now();
    const idle = session?.remembered ? 7 * DAY : 2 * 3_600_000;
    if (
      !session ||
      session.revokedAt ||
      session.expiresAt.getTime() <= now ||
      session.lastSeenAt.getTime() + idle <= now
    )
      throw new UnauthorizedException('登录状态已失效，请重新登录');
    const user = await this.users.findById(session.userId);
    if (!user || (user.authVersion ?? 0) !== session.authVersion)
      throw new UnauthorizedException('登录状态已失效，请重新登录');
    if (!SAFE_METHODS.has(request.method.toUpperCase())) {
      const csrf = request.headers['x-tuanzi-csrf'];
      if (typeof csrf !== 'string' || !equalSecret(csrf, this.csrf(session)))
        throw new ForbiddenException('请求校验失败，请刷新后重试');
    }
    if (touch && now - session.lastSeenAt.getTime() > 60_000)
      await this.sessions.update(
        { id: session.id, revokedAt: IsNull() },
        { lastSeenAt: new Date(now) },
      );
    const { password: _password, ...safeUser } = user;
    request.user = safeUser;
    request.browserSession = session;
    return { session, user };
  }

  async view(session: BrowserSession, user: User | Omit<User, 'password'>) {
    const dsh = await this.grants.existsBy({ userId: user.id, appId: 'dsh' });
    return {
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        role: user.role,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt,
      },
      apps: [
        'home',
        'xunshi',
        'xiaofeiyu',
        ...(user.role === UserRole.ADMIN ? ['admin'] : []),
        ...(dsh ? ['dsh'] : []),
      ],
      csrfToken: this.csrf(session),
      expiresAt: session.expiresAt.toISOString(),
    };
  }

  clearCookie(response: Response) {
    response.clearCookie(this.cookieName, {
      path: '/',
      secure: this.secure,
      httpOnly: true,
      sameSite: 'lax',
    });
  }

  async revoke(session: BrowserSession, id = session.id) {
    const result = await this.sessions.update(
      { id, userId: session.userId, revokedAt: IsNull() },
      { revokedAt: new Date() },
    );
    if (!result.affected && id !== session.id) throw new NotFoundException('设备会话不存在');
    this.closeConnections(id);
  }

  async revokeAll(session: BrowserSession) {
    const ids = await this.database.transaction(async (manager) => {
      await manager.findOne(User, {
        where: { id: session.userId },
        lock: { mode: 'pessimistic_write' },
      });
      await manager.increment(User, { id: session.userId }, 'authVersion', 1);
      const existing = await manager.find(BrowserSession, {
        where: { userId: session.userId, revokedAt: IsNull() },
      });
      await manager.update(
        BrowserSession,
        { userId: session.userId, revokedAt: IsNull() },
        { revokedAt: new Date() },
      );
      return existing.map((item) => item.id);
    });
    ids.forEach((id) => this.closeConnections(id));
  }

  async list(current: BrowserSession) {
    const items = await this.sessions.find({
      where: { userId: current.userId, revokedAt: IsNull(), expiresAt: MoreThan(new Date()) },
      order: { createdAt: 'DESC' },
      take: 100,
    });
    return {
      items: items
        .filter(
          (item) =>
            item.lastSeenAt.getTime() + (item.remembered ? 7 * DAY : 2 * 3_600_000) > Date.now(),
        )
        .map((item) => ({
          id: item.id,
          current: item.id === current.id,
          userAgent: item.userAgent,
          createdAt: item.createdAt,
          lastSeenAt: item.lastSeenAt,
          expiresAt: item.expiresAt,
        })),
    };
  }

  observe(request: SessionRequest, response: Response) {
    const id = request.browserSession?.id;
    if (!id) return;
    const set = this.connections.get(id) ?? new Set<Response>();
    set.add(response);
    this.connections.set(id, set);
    // 已经建立的 SSE 不会再次经过 guard；定期检查到期/撤销，并在主动退出时立即断开。
    const timer = setInterval(() => {
      void this.authenticate(request, false).catch(() => response.end());
    }, 30_000);
    timer.unref();
    const cleanup = () => {
      clearInterval(timer);
      set.delete(response);
      if (!set.size) this.connections.delete(id);
    };
    response.once('finish', cleanup);
    response.once('close', cleanup);
  }

  @Cron('0 20 3 * * *', { timeZone: 'Asia/Shanghai' })
  async cleanupExpired() {
    if (this.enabled)
      await this.sessions.delete({ expiresAt: LessThan(new Date(Date.now() - 30 * DAY)) });
  }

  private closeConnections(id: string) {
    this.connections.get(id)?.forEach((response) => response.end());
  }
}
