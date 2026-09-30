import { INestApplication, UnauthorizedException, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LogsController, LogsAdminGuard } from 'src/logs/logs.controller';
import { LogStore } from 'src/logs/log-store';
import { JwtAuthGuard } from 'src/common/guards/jwt-auth.guard';
import { FileLogger, requestLogging, logContext } from 'src/logs/file-logger';
import { EventEmitter } from 'node:events';

it('并发请求的 requestId 隔离，结束日志不采集请求正文或查询参数', async () => {
  const store = { write: jest.fn() };
  const logger = new FileLogger(store as unknown as LogStore);
  const middleware = requestLogging(logger);
  const values: string[] = [];
  await Promise.all(
    [1, 2].map(async (i) => {
      const response = Object.assign(new EventEmitter(), {
        setHeader: jest.fn(),
        statusCode: 200,
        writableFinished: true,
      });
      await new Promise<void>((resolve) =>
        middleware(
          {
            method: 'POST',
            path: '/api/agents',
            body: { content: '隐私正文' },
            query: { token: '密钥' },
          } as any,
          response as any,
          () => {
            const id = logContext.getStore()!.requestId;
            setTimeout(() => {
              values.push(String(logContext.getStore()!.requestId));
              expect(logContext.getStore()!.requestId).toBe(id);
              response.emit('finish');
              resolve();
            }, i);
          },
        ),
      );
    }),
  );
  expect(new Set(values).size).toBe(2);
  expect(JSON.stringify(store.write.mock.calls)).not.toMatch(/隐私正文|密钥/);
});

describe('日志查询 HTTP 权限与校验', () => {
  let app: INestApplication;
  let origin: string;
  let store: LogStore;
  let directory: string;
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'logs-http-'));
    store = new LogStore({ directory, now: () => new Date('2026-09-14T12:00:00Z') });
    await store.initialize();
    store.write('error', { message: '真实文件中的错误', conversationId: 'conversation1' });
    await store.flush();
    const module = await Test.createTestingModule({
      controllers: [LogsController],
      providers: [
        LogsAdminGuard,
        {
          provide: LogStore,
          useValue: store,
        },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({
        canActivate: (context: any) => {
          const request = context.switchToHttp().getRequest();
          if (!request.headers['x-test-role']) throw new UnauthorizedException();
          request.user = { role: request.headers['x-test-role'] };
          return true;
        },
      })
      .compile();
    app = module.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }),
    );
    await app.listen(0, '127.0.0.1');
    origin = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await app.close();
    await store.close();
    await rm(directory, { recursive: true, force: true });
  });
  it('匿名401、普通用户403，管理员可查询且响应禁止缓存', async () => {
    expect((await fetch(`${origin}/admin/logs?date=2026-09-14`)).status).toBe(401);
    expect(
      (await fetch(`${origin}/admin/logs?date=2026-09-14`, { headers: { 'x-test-role': 'user' } }))
        .status,
    ).toBe(403);
    const result = await fetch(`${origin}/admin/logs?date=2026-09-14`, {
      headers: { 'x-test-role': 'admin' },
    });
    expect(result.status).toBe(200);
    expect(result.headers.get('cache-control')).toBe('no-store');
    expect((await result.json()).items[0]).toEqual(
      expect.objectContaining({ message: '真实文件中的错误', conversationId: 'conversation1' }),
    );
  });
  it('存储状态仅管理员可读，按日期汇总真实文件大小且不暴露路径', async () => {
    expect((await fetch(`${origin}/admin/logs/status`)).status).toBe(401);
    expect(
      (await fetch(`${origin}/admin/logs/status`, { headers: { 'x-test-role': 'user' } })).status,
    ).toBe(403);
    const response = await fetch(`${origin}/admin/logs/status`, {
      headers: { 'x-test-role': 'admin' },
    });
    const result = await response.json();
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(result.days).toEqual([
      { date: '2026-09-14', totalBytes: result.totalBytes, compressedBytes: 0, fileCount: 1 },
    ]);
    expect(result.checkedAt).toBe('2026-09-14T12:00:00.000Z');
    expect(JSON.stringify(result)).not.toContain(directory);
  });
  it('拒绝任意路径参数、超大页和非法级别', async () => {
    for (const suffix of [
      '&path=/etc/passwd',
      '&limit=100000',
      '&level=xxx',
      '&cursor=' + 'a'.repeat(1025),
    ]) {
      expect(
        (
          await fetch(`${origin}/admin/logs?date=2026-09-14${suffix}`, {
            headers: { 'x-test-role': 'admin' },
          })
        ).status,
      ).toBe(400);
    }
  });
});
