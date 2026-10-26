import { SinaScannerService } from 'src/stock-signals/sina-scanner.service';
jest.mock('src/common/utils/ssrf.util', () => ({
  assertPublicUrl: jest.fn(async (url: string) => new URL(url)),
}));

describe('新浪历史信号解析与抓取', () => {
  const item = { code: '600396', market: 'sh' as const, name: '华电辽能' };
  let service: SinaScannerService;
  let fetchMock: jest.SpyInstance;
  const reply = (data: Record<string, unknown>) => ({
    ok: true,
    text: async () => `var _touzibullbear_sh600396=${JSON.stringify(data)}; /* source */`,
  });

  beforeEach(() => {
    service = new SinaScannerService();
    fetchMock = jest.spyOn(global, 'fetch');
  });
  afterEach(() => jest.restoreAllMocks());

  it('当天没有键时仍保留很久以前的 S，兼容紧凑日期与数字信号', async () => {
    fetchMock.mockResolvedValue(reply({ '2026-09-10': '1', '20260915': 0 }));
    expect(await service.fetchHistory(item)).toEqual({
      item,
      signals: { '2026-09-10': '1', '2026-09-15': '0' },
    });
    expect(await service.fetchOne(item, '2026-10-26')).toEqual({ item, value: null });
  });

  it('忽略非日期元数据与无效日历日期，同日 ISO 键优先', async () => {
    fetchMock.mockResolvedValue(
      reply({ '20260915': '1', '2026-09-15': '0', '2026-02-30': '0', update: 'x' }),
    );
    expect((await service.fetchHistory(item)).signals).toEqual({ '2026-09-15': '0' });
  });

  it.each([{}, { '2026-09-15': 'unknown' }, { '2026-09-15': {} }])(
    '缺失或非法历史不能当成检查成功：%j',
    async (data) => {
      fetchMock.mockResolvedValue(reply(data));
      await expect(service.fetchHistory(item)).rejects.toThrow();
    },
  );

  it('响应格式异常和 HTTP 失败均作为失败处理', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, text: async () => '<html>error</html>' });
    await expect(service.fetchHistory(item)).rejects.toThrow('响应格式');
    fetchMock.mockResolvedValueOnce({ ok: false, status: 503 });
    await expect(service.fetchHistory(item)).rejects.toThrow('503');
  });

  it('批量请求隔离单只失败，并保持最大 12 路并发', async () => {
    let active = 0,
      peak = 0;
    fetchMock.mockImplementation(async (url: URL) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setImmediate(resolve));
      active--;
      if (url.href.includes('600001')) throw new Error('network');
      return reply({ '2026-09-15': '0' });
    });
    const items = Array.from({ length: 15 }, (_, index) => ({
      ...item,
      code: String(600000 + index),
    }));
    const result = await service.scanHistory(items);
    expect(result.results).toHaveLength(14);
    expect(result.failures).toEqual(['SH600001']);
    expect(peak).toBe(12);
    expect(fetchMock).toHaveBeenCalledTimes(15);
  });
});
