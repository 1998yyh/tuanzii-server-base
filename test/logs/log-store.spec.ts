import { mkdtemp, readFile, readdir, rm, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ServiceUnavailableException } from '@nestjs/common';
import { LogStore } from 'src/logs/log-store';
import { FileLogger } from 'src/logs/file-logger';
import { sanitizeLog, errorFields } from 'src/logs/log-record';

describe('文件日志留存与查询', () => {
  let directory: string;
  let store: LogStore;
  const now = () => new Date('2026-09-14T12:00:00Z');
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'tuanzi-logs-'));
    store = new LogStore({ directory, now, segmentBytes: 1024 });
    await store.initialize();
  });
  afterEach(async () => {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  });

  it('按会话与级别查询，翻页期间的新日志不会重复旧记录', async () => {
    for (let i = 0; i < 6; i++) store.write('error', { message: `错误${i}`, conversationId: 'c1' });
    store.write('info', { message: '其他会话', conversationId: 'c2' });
    await store.flush();
    const first = await store.query({
      date: '2026-09-14',
      conversationId: 'c1',
      level: 'error',
      limit: 2,
    });
    expect(first.items.map((r) => r.message)).toEqual(['错误5', '错误4']);
    store.write('error', { message: '新错误', conversationId: 'c1' });
    await store.flush();
    const second = await store.query({
      date: '2026-09-14',
      conversationId: 'c1',
      level: 'error',
      limit: 2,
      cursor: first.nextCursor!,
    });
    expect(second.items.map((r) => r.message)).toEqual(['错误3', '错误2']);
  });

  it.each(['warn', 'fatal'] as const)(
    '%s级别的SDK异常只保存摘要，不保存聊天正文',
    async (level) => {
      const logger = new FileLogger(store);
      logger[level](
        '后台任务失败: 400 {"error":{"message":"request failed"},"messages":[{"content":"SYNTHETIC_PRIVATE_CHAT"}]}',
      );
      await store.flush();
      const result = await store.query({ date: '2026-09-14' });
      expect(result.items[0].message).toBe('request failed');
      expect(JSON.stringify(result.items)).not.toContain('SYNTHETIC_PRIVATE_CHAT');
    },
  );

  it('跨天压缩且重启后仍能按请求 ID 查到旧日志', async () => {
    let date = new Date('2026-09-13T12:00:00Z');
    await store.close();
    store = new LogStore({ directory, now: () => date, segmentBytes: 1024 });
    await store.initialize();
    store.write('error', { message: '上游拒绝', requestId: 'r1' });
    await store.flush();
    date = now();
    await store.maintain();
    expect((await readdir(directory)).some((name) => name.endsWith('.gz'))).toBe(true);
    await store.close();
    store = new LogStore({ directory, now, segmentBytes: 1024 });
    await store.initialize();
    expect((await store.query({ date: '2026-09-13', requestId: 'r1' })).items[0].message).toBe(
      '上游拒绝',
    );
  });

  it('清理第15天的日志但保留第14天，不删除无关文件', async () => {
    await writeFile(join(directory, 'app-2026-08-31-1000000000000.jsonl'), '{}\n');
    await writeFile(join(directory, 'app-2026-09-01-1000000000000.jsonl'), '{}\n');
    await writeFile(join(directory, 'keep.txt'), '保留');
    await store.maintain();
    const files = await readdir(directory);
    expect(files.some((name) => name.includes('2026-08-31'))).toBe(false);
    expect(files.some((name) => name.includes('2026-09-01'))).toBe(true);
    expect(await readFile(join(directory, 'keep.txt'), 'utf8')).toBe('保留');
  });

  it('拒绝路径、非法日期和伪造游标', async () => {
    for (const date of ['../../etc/passwd', '2026-02-30', '2026-08-31']) {
      await expect(store.query({ date })).rejects.toThrow();
    }
    await expect(store.query({ date: '2026-09-14', cursor: 'invalid' })).rejects.toThrow();
    await symlink('/etc/passwd', join(directory, 'app-2026-09-14-1000000000000.jsonl'));
    expect((await store.query({ date: '2026-09-14' })).items).toEqual([]);
  });

  it('扫描到上限时返回可继续的游标，不把未扫描完显示为无结果', async () => {
    await store.close();
    store = new LogStore({ directory, now, segmentBytes: 512, scanBytes: 512 });
    await store.initialize();
    for (let i = 0; i < 12; i++) store.write('info', { message: '一条日志'.repeat(10) });
    await store.flush();
    const result = await store.query({ date: '2026-09-14', level: 'error' });
    expect(result.items).toEqual([]);
    expect(result.scanLimited).toBe(true);
    expect(result.nextCursor).toBeTruthy();
  });

  it('容量超限先清理最旧分片，保留当前写入并报告实际占用', async () => {
    await store.close();
    store = new LogStore({ directory, now, segmentBytes: 1024, maxBytes: 2048 });
    await store.initialize();
    for (let i = 0; i < 30; i++) store.write('info', { message: `${i}:` + '日志'.repeat(30) });
    await store.flush();
    await store.maintain();
    const status = await store.status();
    expect(status.totalBytes).toBeLessThanOrEqual(2048);
    expect((await store.query({ date: '2026-09-14', limit: 1 })).items[0].message).toMatch(/^29:/);
  });

  it('并发维护和写入不会漏记录，查询游标不能跨筛选条件复用', async () => {
    const maintenance = store.maintain();
    const secondMaintenance = store.maintain();
    for (let i = 0; i < 20; i++) store.write('info', { message: `并发${i}` });
    await Promise.all([maintenance, secondMaintenance]);
    await store.flush();
    const result = await store.query({ date: '2026-09-14', limit: 2 });
    expect(result.items.map((entry) => entry.message)).toEqual(['并发19', '并发18']);
    await expect(
      store.query({ date: '2026-09-14', level: 'error', cursor: result.nextCursor! }),
    ).rejects.toThrow('游标无效');
    expect((await store.query({ date: '2026-09-14' })).items).toHaveLength(20);
  });

  it('完整 JSONL 行损坏时返回503，不误报为没有日志', async () => {
    await writeFile(join(directory, 'app-2026-09-14-1000000000000.jsonl'), 'broken json\n');
    await expect(store.query({ date: '2026-09-14' })).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('忽略崩溃残留的未完成行，压缩损坏时明确报错', async () => {
    await writeFile(join(directory, 'app-2026-09-14-1000000000000.jsonl'), '{"id":"unfinished"');
    expect((await store.query({ date: '2026-09-14' })).items).toEqual([]);
    await writeFile(join(directory, 'app-2026-09-14-1000000000001.jsonl.gz'), 'broken gzip');
    await expect(store.query({ date: '2026-09-14' })).rejects.toThrow('无法读取');
  });
});

describe('日志脱敏', () => {
  it('仅保存允许的字段，清除凭据和正文，不执行 HTML', () => {
    const record = sanitizeLog({
      message:
        '401 Authorization: Bearer secret-value https://user:pass@api.example.com/v1?key=secret',
      apiKey: 'secret-key',
      content: '聊天正文',
      reasoning: '思考正文',
      stack: 'api_key=secret-key password="secret-password"',
      modelName: 'model-a',
    });
    expect(JSON.stringify(record)).not.toMatch(
      /secret-value|secret-key|secret-password|聊天正文|思考正文|user:pass/,
    );
    expect(record.modelName).toBe('model-a');
  });
  it('提取 SDK 与本地异常状态，不保留上游请求体', () => {
    expect(
      errorFields({ status: 401, message: '401 invalid_api_key', request: { body: '隐私' } }),
    ).toEqual(expect.objectContaining({ upstreamStatus: 401 }));
    expect(
      JSON.stringify(
        errorFields({
          message: JSON.stringify({
            error: { message: '不支持搜索', code: 'unsupported' },
            messages: ['隐私'],
          }),
        }),
      ),
    ).not.toContain('隐私');
  });

  it('自由文本中的 Basic 凭据、完整 Cookie 与 JSON 正文均脱敏', () => {
    const text = sanitizeLog({
      message:
        'Authorization: Basic dXNlcjpwYXNz\nCookie: sid=private; refresh=private2\npassword="private3"',
    });
    expect(JSON.stringify(text)).not.toMatch(/dXNlcjpwYXNz|private/);
  });
});
