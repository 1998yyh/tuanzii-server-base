import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { Test } from '@nestjs/testing';
import { json } from 'express';
import { TokenType } from 'src/auth/auth.service';
import { JwtStrategy } from 'src/auth/jwt.strategy';
import { UsersService } from 'src/users/users.service';
import { UserRole } from 'src/users/users.entity';
import { XiaofeiyuDiaryController } from 'src/xiaofeiyu-diary/xiaofeiyu-diary.controller';
import { XiaofeiyuDiaryWebhookController } from 'src/xiaofeiyu-diary/xiaofeiyu-diary-webhook.controller';
import { XiaofeiyuDiaryWebhookGuard } from 'src/xiaofeiyu-diary/xiaofeiyu-diary.guards';
import { XiaofeiyuDiaryService } from 'src/xiaofeiyu-diary/xiaofeiyu-diary.service';

describe('小肥鱼日记HTTP与真实JWT边界', () => {
  let app: INestApplication;
  let base: string;
  let adminToken: string;
  let userToken: string;
  let refreshToken: string;
  let role = UserRole.ADMIN;
  let userExists = true;
  let hookKey: string | undefined;
  const key = 'test-only-webhook-key-'.repeat(3);
  const jwt = new JwtService({ secret: 'test-only-signing-key' });
  const diary = {
    findAll: jest.fn().mockResolvedValue({
      items: [],
      total: 0,
      page: 1,
      limit: 30,
      totalPages: 0,
      allTotal: 0,
      unread: 0,
      hasMore: false,
    }),
    markRead: jest.fn().mockResolvedValue({ ok: true }),
    markAllRead: jest.fn().mockResolvedValue({ ok: true }),
    receive: jest.fn().mockResolvedValue({ ok: true, id: '11111111-1111-4111-8111-111111111111' }),
  };

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [PassportModule.register({ defaultStrategy: 'jwt' })],
      controllers: [XiaofeiyuDiaryController, XiaofeiyuDiaryWebhookController],
      providers: [
        JwtStrategy,
        XiaofeiyuDiaryWebhookGuard,
        { provide: XiaofeiyuDiaryService, useValue: diary },
        {
          provide: ConfigService,
          useValue: {
            get: (name: string) =>
              name === 'JWT_SECRET'
                ? 'test-only-signing-key'
                : name === 'XIAOFEIYU_WEBHOOK_KEY'
                  ? hookKey
                  : undefined,
          },
        },
        {
          provide: UsersService,
          useValue: {
            findById: async (id: string) =>
              userExists
                ? {
                    id,
                    role: id === 'admin' ? role : UserRole.USER,
                    username: '测试账号',
                    password: '仅测试',
                  }
                : null,
          },
        },
      ],
    }).compile();
    app = module.createNestApplication({ bodyParser: false });
    app.use(json({ limit: '5mb' }));
    app.setGlobalPrefix('api');
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.listen(0, '127.0.0.1');
    base = await app.getUrl();
    adminToken = jwt.sign({ sub: 'admin', type: TokenType.ACCESS }, { expiresIn: 60 });
    userToken = jwt.sign({ sub: 'user', type: TokenType.ACCESS }, { expiresIn: 60 });
    refreshToken = jwt.sign({ sub: 'admin', type: TokenType.REFRESH }, { expiresIn: 60 });
  });

  beforeEach(() => {
    hookKey = key;
    role = UserRole.ADMIN;
    userExists = true;
    jest.clearAllMocks();
  });
  afterAll(async () => app.close());

  function list(path = '', token = adminToken) {
    return fetch(base + '/api/xiaofeiyu/entries' + path, {
      headers: token ? { Authorization: 'Bearer ' + token } : {},
    });
  }
  function receive(body: unknown, suffix = '?key=' + key, headers: Record<string, string> = {}) {
    return fetch(base + '/api/internal/xiaofeiyu/webhook' + suffix, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
  }

  it('缺少、伪造和refresh令牌均不能阅读', async () => {
    for (const token of ['', 'invalid', refreshToken])
      expect((await list('', token)).status).toBe(401);
  });
  it('普通用户可以阅读并标记单篇和全部已读', async () => {
    expect((await list('', userToken)).status).toBe(200);
    expect(
      (
        await fetch(base + '/api/xiaofeiyu/entries/read-all', {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + userToken },
        })
      ).status,
    ).toBe(201);
    expect(
      (
        await fetch(base + '/api/xiaofeiyu/entries/11111111-1111-4111-8111-111111111111/read', {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + userToken },
        })
      ).status,
    ).toBe(201);
    expect(diary.markAllRead).toHaveBeenCalledTimes(1);
    expect(diary.markRead).toHaveBeenCalledWith('11111111-1111-4111-8111-111111111111');
  });
  it('有效管理员返回标准分页及no-store', async () => {
    const response = await list('?page=1&limit=30');
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toMatchObject({ items: [], page: 1, totalPages: 0 });
  });
  it('管理员降为普通用户后仍能阅读', async () => {
    role = UserRole.USER;
    expect((await list()).status).toBe(200);
  });
  it('账号删除后原令牌仍被拒绝', async () => {
    userExists = false;
    expect((await list()).status).toBe(401);
    expect(diary.findAll).not.toHaveBeenCalled();
  });
  it.each(['read-all', '11111111-1111-4111-8111-111111111111/read'])(
    '匿名用户不能标记已读：%s',
    async (suffix) => {
      const response = await fetch(base + '/api/xiaofeiyu/entries/' + suffix, { method: 'POST' });
      expect(response.status).toBe(401);
      expect(diary.markAllRead).not.toHaveBeenCalled();
      expect(diary.markRead).not.toHaveBeenCalled();
    },
  );
  it.each(['?page=0', '?limit=101', '?unread=true', '?q=' + 'x'.repeat(201), '?userId=other'])(
    '拒绝无效查询%s',
    async (query) => {
      expect((await list(query)).status).toBe(400);
      expect(diary.findAll).not.toHaveBeenCalled();
    },
  );
  it('标记已读使用UUID校验', async () => {
    const request = (id: string) =>
      fetch(base + '/api/xiaofeiyu/entries/' + id + '/read', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + adminToken },
      });
    expect((await request('1')).status).toBe(400);
    expect((await request('11111111-1111-4111-8111-111111111111')).status).toBe(201);
  });
  it('正确本机Webhook无需JWT，兼容插件格式', async () => {
    const body = { title: '测试日记', text: '正文', content: '正文', format: 'text' };
    expect((await receive(body)).status).toBe(201);
    expect(diary.receive).toHaveBeenCalledWith(expect.objectContaining(body));
  });
  it.each(['分享前评论检查', '分享评论报备', '自主发言报备'])(
    '评论流程通知返回200与显式标记，普通日记仍返回201：%s',
    async (title) => {
      const result = { ok: true, ignored: true, reason: `${title}通知不写入日记` };
      diary.receive.mockResolvedValueOnce(result);
      const response = await receive({ title, text: '隔离测试通知' });
      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(await response.json()).toEqual(result);
      expect((await receive({ title: '小肥鱼日记', text: '普通日记' })).status).toBe(201);
    },
  );
  it.each(['分享前评论检查', '分享评论报备', '自主发言报备'])(
    '评论流程通知仍经过密钥和DTO校验：%s',
    async (title) => {
      expect((await receive({ title, text: '隔离测试通知' }, '?key=wrong')).status).toBe(403);
      expect((await receive({ title, text: '隔离测试通知', unknown: true })).status).toBe(400);
      expect(diary.receive).not.toHaveBeenCalled();
    },
  );
  it('支持密钥请求头且优先于query', async () => {
    expect((await receive({ text: '正文' }, '?key=wrong', { 'X-Xiaofeiyu-Key': key })).status).toBe(
      201,
    );
    expect(
      (await receive({ text: '正文' }, '?key=' + key, { 'X-Xiaofeiyu-Key': 'wrong' })).status,
    ).toBe(403);
  });
  it('缺少或错误密钥拒绝收信', async () => {
    expect((await receive({ text: '正文' }, '')).status).toBe(403);
    expect((await receive({ text: '正文' }, '?key=wrong')).status).toBe(403);
  });
  it('即使共享应用允许5mb正文，日记也拒绝超过256KiB的推送', async () => {
    // 字符数未超过DTO上限，但UTF-8实际字节数超限，必须在入库前拒绝。
    expect((await receive({ text: '鱼'.repeat(90000) })).status).toBe(413);
    expect(diary.receive).not.toHaveBeenCalled();
  });
  it.each(['X-Forwarded-For', 'Forwarded', 'X-Real-IP'])(
    '拒绝从反代入口进入的请求：%s',
    async (name) => {
      expect((await receive({ text: '正文' }, '?key=' + key, { [name]: '127.0.0.1' })).status).toBe(
        403,
      );
      expect(diary.receive).not.toHaveBeenCalled();
    },
  );
  it('未配置密钥仅关闭Webhook，不阻断日记读取', async () => {
    hookKey = undefined;
    expect((await receive({ text: '正文' })).status).toBe(503);
    expect((await list()).status).toBe(200);
  });
  it.each([{ text: [] }, { text: '正文', isRead: true }, { title: 'x'.repeat(301), text: '正文' }])(
    '校验Webhook DTO%j',
    async (body) => {
      expect((await receive(body)).status).toBe(400);
      expect(diary.receive).not.toHaveBeenCalled();
    },
  );
});
