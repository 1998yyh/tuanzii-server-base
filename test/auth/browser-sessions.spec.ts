import { BrowserSessionsService, hashSessionToken } from 'src/auth/browser-sessions.service';
import type { SessionRequest } from 'src/auth/browser-sessions.service';
import { BrowserSession } from 'src/auth/browser-session.entity';
import { User, UserRole } from 'src/users/users.entity';
import { ConfigService } from '@nestjs/config';
import { DataSource, Repository } from 'typeorm';
import { UsersService } from 'src/users/users.service';
import type { Response } from 'express';
import { createHmac } from 'node:crypto';

describe('统一浏览器会话的安全边界', () => {
  const secret = 'ab'.repeat(32),
    token = 'a'.repeat(43);
  const user = {
    id: 'owner',
    username: 'owner',
    email: 'owner@example.test',
    password: 'hash',
    role: UserRole.USER,
    authVersion: 0,
  } as User;
  let service: BrowserSessionsService;
  let session: BrowserSession;
  const repository = { findOne: jest.fn(), update: jest.fn(), find: jest.fn() };
  const grants = { existsBy: jest.fn() };
  const users = {
    findById: jest.fn(),
    findByEmail: jest.fn(),
    findByUsername: jest.fn(),
    validatePassword: jest.fn(),
  };
  const manager = {
    findOne: jest.fn(),
    update: jest.fn(),
    create: jest.fn((_entity, value) => value),
    save: jest.fn(),
    increment: jest.fn(),
    find: jest.fn(),
  };
  const database = { transaction: jest.fn((callback) => callback(manager)) };
  const config = new ConfigService({
    WEB_SESSION_ENABLED: 'true',
    AUTH_ORIGIN: 'https://example.test',
    AUTH_CSRF_SECRET: secret,
    NODE_ENV: 'production',
  });
  const request = (method = 'GET', extra: Record<string, string> = {}) =>
    ({
      method,
      headers: { cookie: `__Host-tuanzi_session=${token}`, ...extra },
      socket: { remoteAddress: '127.0.0.1' },
      get: () => 'test browser',
      is: () => true,
    }) as unknown as SessionRequest;
  const csrf = () =>
    createHmac('sha256', Buffer.from(secret, 'hex'))
      .update(`csrf:${session.id}:0`)
      .digest('base64url');

  beforeEach(() => {
    jest.clearAllMocks();
    session = {
      id: 'session',
      userId: 'owner',
      authVersion: 0,
      revokedAt: null,
      remembered: false,
      expiresAt: new Date(Date.now() + 12 * 3600_000),
      lastSeenAt: new Date(),
    } as BrowserSession;
    repository.findOne.mockResolvedValue(session);
    repository.update.mockResolvedValue({ affected: 1 });
    users.findById.mockResolvedValue(user);
    grants.existsBy.mockResolvedValue(false);
    service = new BrowserSessionsService(
      repository as unknown as Repository<BrowserSession>,
      grants as never,
      users as unknown as UsersService,
      database as unknown as DataSource,
      config,
    );
  });

  it('凭据仅以哈希查库，响应不包含密码、会话凭据或认证版本', async () => {
    const result = await service.authenticate(request());
    expect(repository.findOne).toHaveBeenCalledWith({
      where: { tokenHash: hashSessionToken(token) },
    });
    const view = await service.view(result.session, result.user);
    expect(view.user).not.toHaveProperty('password');
    expect(view.user).not.toHaveProperty('authVersion');
    expect(view).not.toHaveProperty('accessToken');
    expect(view.apps).not.toContain('admin');
    expect(view.apps).not.toContain('dsh');
  });
  it('管理员也不自动获得 dsh 授权', async () => {
    const view = await service.view(session, { ...user, role: UserRole.ADMIN });
    expect(view.apps).toContain('admin');
    expect(view.apps).not.toContain('dsh');
    grants.existsBy.mockResolvedValue(true);
    expect((await service.view(session, user)).apps).toContain('dsh');
  });
  it.each(['expired', 'idle', 'revoked', 'version', 'deleted'])('拒绝 %s 会话', async (kind) => {
    if (kind === 'expired') session.expiresAt = new Date(Date.now() - 1);
    if (kind === 'idle') session.lastSeenAt = new Date(Date.now() - 3 * 3600_000);
    if (kind === 'revoked') session.revokedAt = new Date();
    if (kind === 'version') users.findById.mockResolvedValue({ ...user, authVersion: 1 });
    if (kind === 'deleted') users.findById.mockResolvedValue(null);
    await expect(service.authenticate(request())).rejects.toMatchObject({ status: 401 });
  });
  it('Cookie 重名或格式错误不作为身份', async () => {
    expect(
      service.token(
        request('GET', {
          cookie: `__Host-tuanzi_session=${token}; __Host-tuanzi_session=${token}`,
        }),
      ),
    ).toBeUndefined();
    expect(
      service.token(request('GET', { cookie: '__Host-tuanzi_session=short' })),
    ).toBeUndefined();
    await expect(service.authenticate(request('GET', { cookie: '' }))).rejects.toMatchObject({
      status: 401,
    });
  });
  it('写操作必须同时通过本站 Origin 与会话绑定的 CSRF 校验', async () => {
    await expect(service.authenticate(request('POST'))).rejects.toMatchObject({ status: 403 });
    await expect(
      service.authenticate(
        request('POST', { origin: 'https://evil.test', 'x-tuanzi-csrf': csrf() }),
      ),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      service.authenticate(
        request('POST', { origin: 'https://example.test', 'x-tuanzi-csrf': 'wrong' }),
      ),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      service.authenticate(
        request('POST', { origin: 'https://example.test', 'x-tuanzi-csrf': csrf() }),
      ),
    ).resolves.toHaveProperty('user.id', 'owner');
  });
  it('数据库故障向上传播，不伪装成无效登录', async () => {
    repository.findOne.mockRejectedValue(new Error('storage offline'));
    await expect(service.authenticate(request())).rejects.toThrow('storage offline');
  });
  it('只能撤销自己的设备且不会暴露别人的设备是否存在', async () => {
    await service.revoke(session, 'other-session');
    expect(repository.update.mock.calls[0][0]).toMatchObject({
      id: 'other-session',
      userId: 'owner',
    });
    repository.update.mockResolvedValue({ affected: 0 });
    await expect(service.revoke(session, 'not-owned')).rejects.toMatchObject({ status: 404 });
  });
  it('全部撤销在事务中提升用户认证版本', async () => {
    manager.find.mockResolvedValue([session]);
    await service.revokeAll(session);
    expect(manager.increment).toHaveBeenCalledWith(User, { id: 'owner' }, 'authVersion', 1);
  });
  it('登录生成新随机凭据且 Cookie 具备 HTTPS 安全属性', async () => {
    users.findByEmail.mockResolvedValue(user);
    users.validatePassword.mockResolvedValue(true);
    manager.findOne.mockResolvedValue(user);
    manager.save.mockImplementation((_entity, value) => ({ ...value, id: 'new-session' }));
    const response = { cookie: jest.fn() } as unknown as Response;
    const view = await service.create(
      { login: 'owner', password: 'correct', remember: true },
      request('POST', { origin: 'https://example.test', 'x-tuanzi-csrf': 'login' }),
      response,
    );
    const call = (response.cookie as jest.Mock).mock.calls[0];
    expect(call[0]).toBe('__Host-tuanzi_session');
    expect(call[1]).toMatch(/^[\w-]{43}$/);
    expect(call[1]).not.toBe(token);
    expect(call[2]).toMatchObject({
      secure: true,
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      maxAge: 7 * 86_400_000,
    });
    expect(call[2]).not.toHaveProperty('domain');
    expect(manager.save.mock.calls[0][1].tokenHash).toBe(hashSessionToken(call[1]));
    expect(view).not.toHaveProperty('accessToken');
  });
  it('生产环境不允许通过调试开关启用 HTTP', () => {
    expect(
      () =>
        new BrowserSessionsService(
          repository as never,
          grants as never,
          users as never,
          database as never,
          new ConfigService({
            WEB_SESSION_ENABLED: 'true',
            AUTH_ORIGIN: 'http://127.0.0.1',
            AUTH_CSRF_SECRET: secret,
            NODE_ENV: 'production',
            WEB_SESSION_ALLOW_LOCAL_HTTP: 'true',
          }),
        ),
    ).toThrow('统一登录必须使用 HTTPS');
  });
});
