import { StockPerformanceService } from 'src/stock-signals/stock-performance.service';

jest.mock('src/common/utils/ssrf.util', () => ({
  assertPublicUrl: jest.fn(async (url: string) => new URL(url)),
}));

describe('东方财富筛选日与距今涨幅', () => {
  let service: StockPerformanceService;
  let fetchMock: jest.SpyInstance;
  const epoch = (time: string) => Date.parse(time) / 1000;
  const bars = [
    '2026-09-09,8,8,8,8,100,100,0,0',
    '2026-09-10,9,10,10,9,100,100,0,19.99',
    '2026-10-27,11,12,12,11,100,100,0,3',
  ];
  const history = (code = '600396', klines: unknown = bars) => ({
    ok: true,
    json: async () => ({ rc: 0, data: { code, klines } }),
  });
  const quotes = (
    code = '600396',
    price: unknown = 12,
    time: unknown = epoch('2026-10-27T02:00:00Z'),
    change: unknown = 3,
  ) => ({
    ok: true,
    json: async () => ({
      rc: 0,
      data: {
        f57: code,
        f43: price,
        f86: time,
        f170: change,
      },
    }),
  });
  function mock(
    options: {
      klines?: unknown;
      price?: unknown;
      time?: unknown;
      change?: unknown;
      quoteFails?: boolean;
    } = {},
  ) {
    fetchMock.mockImplementation(async (url: URL) => {
      const code = (url.searchParams.get('secid') ?? url.searchParams.get('secids'))!.split('.')[1];
      if (url.hostname === 'push2his.eastmoney.com') return history(code, options.klines ?? bars);
      if (options.quoteFails) throw new Error('quote unavailable');
      return quotes(
        code,
        'price' in options ? options.price : 12,
        'time' in options ? options.time : epoch('2026-10-27T02:00:00Z'),
        'change' in options ? options.change : 3,
      );
    });
  }
  beforeEach(() => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'setTimeout', 'clearTimeout'] });
    jest.setSystemTime(new Date('2026-10-27T02:01:00Z'));
    service = new StockPerformanceService();
    fetchMock = jest.spyOn(global, 'fetch');
  });
  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it('历史当日直接使用东财 f59，不借用今天 f170 或自行按舍入价格反算', async () => {
    mock();
    expect((await service.get('2026-09-10', ['600396'])).items[0]).toMatchObject({
      dayPercent: 19.99,
      sincePercent: 20,
      source: 'eastmoney',
      adjustment: 'qfq',
      date: '2026-09-10',
      quoteAsOf: '2026-10-27T02:00:00.000Z',
      dayReason: null,
      sinceReason: null,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const historyUrl = fetchMock.mock.calls.find(
      ([url]) => (url as URL).hostname === 'push2his.eastmoney.com',
    )![0] as URL;
    expect(historyUrl.searchParams.get('fqt')).toBe('1');
    expect(historyUrl.searchParams.get('fields2')).toContain('f59');
    expect(
      fetchMock.mock.calls.every(([url]) =>
        ['push2.eastmoney.com', 'push2his.eastmoney.com'].includes((url as URL).hostname),
      ),
    ).toBe(true);
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ redirect: 'error' });
  });
  it('当前日盘中使用东财 f170，累计等待收盘', async () => {
    mock();
    expect((await service.get('2026-10-27', ['600396'])).items[0]).toMatchObject({
      dayPercent: 3,
      sincePercent: null,
      sinceReason: '基准日未收盘',
    });
  });
  it('当日收盘后可展示真实零值', async () => {
    jest.setSystemTime(new Date('2026-10-27T07:10:00Z'));
    mock({ time: epoch('2026-10-27T07:00:00Z'), change: 0 });
    expect((await service.get('2026-10-27', ['600396'])).items[0]).toMatchObject({
      dayPercent: 0,
      sincePercent: 0,
      sinceReason: null,
    });
  });
  it('没有历史目标日不借用邻近日期', async () => {
    mock();
    expect((await service.get('2026-09-11', ['600396'])).items[0]).toMatchObject({
      dayPercent: null,
      sincePercent: null,
      dayReason: '无该日行情',
    });
  });
  it('缺少上一交易日时仍能使用来源提供的 f59', async () => {
    mock({ klines: bars.slice(1) });
    expect((await service.get('2026-09-10', ['600396'])).items[0]).toMatchObject({
      dayPercent: 19.99,
      sincePercent: 20,
    });
  });
  it('历史 f59 缺失不回填今天涨幅，也不冒充零', async () => {
    mock({ klines: [bars[0], bars[1].replace('19.99', '-')] });
    expect((await service.get('2026-09-10', ['600396'])).items[0]).toMatchObject({
      dayPercent: null,
      sincePercent: 20,
      dayReason: '缺少当日涨幅',
    });
  });
  it.each(['', '-', null, 0, 'NaN'])(
    '无效报价 %j 不当成累计零值，历史涨幅可保留',
    async (price) => {
      mock({ price });
      expect((await service.get('2026-09-10', ['600396'])).items[0]).toMatchObject({
        dayPercent: 19.99,
        sincePercent: null,
        sinceReason: '无有效最新报价',
      });
    },
  );
  it('停牌或非交易日保留实际报价时间', async () => {
    mock({ time: epoch('2026-10-26T07:00:00Z') });
    expect((await service.get('2026-09-10', ['600396'])).items[0]).toMatchObject({
      sincePercent: 20,
      quoteAsOf: '2026-10-26T07:00:00.000Z',
    });
  });
  it('今天只有旧报价不冒充当前日行情', async () => {
    mock({ time: epoch('2026-10-26T07:00:00Z') });
    expect((await service.get('2026-10-27', ['600396'])).items[0]).toMatchObject({
      dayPercent: null,
      dayReason: '无当日报价',
      sincePercent: null,
    });
  });
  it.each([epoch('2026-09-09T07:00:00Z'), epoch('2026-10-28T01:30:00Z'), null, '-', 0])(
    '报价时间 %j 无效或早于基准时累计缺失',
    async (time) => {
      mock({ time });
      expect((await service.get('2026-09-10', ['600396'])).items[0].sincePercent).toBeNull();
    },
  );
  it.each([[...bars].reverse(), ['2026-09-10,1,,1,1,100,100,0,0'], ['bad']])(
    '非法日线降级：%j',
    async (klines) => {
      mock({ klines });
      expect((await service.get('2026-09-10', ['600396'])).items[0]).toMatchObject({
        dayPercent: null,
        sincePercent: null,
      });
    },
  );
  it('报价接口失败不回退腾讯，仍展示已取到的东财历史涨幅', async () => {
    mock({ quoteFails: true });
    expect((await service.get('2026-09-10', ['600396'])).items[0]).toMatchObject({
      dayPercent: 19.99,
      sincePercent: null,
      source: 'eastmoney',
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(
      fetchMock.mock.calls.every(([url]) => (url as URL).hostname.endsWith('.eastmoney.com')),
    ).toBe(true);
  });
  it('历史接口断连时，当前日已取到的东财报价仍可显示', async () => {
    fetchMock.mockImplementation(async (url: URL) => {
      if (url.hostname === 'push2.eastmoney.com') return quotes();
      throw new Error('history unavailable');
    });
    expect((await service.get('2026-10-27', ['600396'])).items[0]).toMatchObject({
      dayPercent: 3,
      sincePercent: null,
      sinceReason: '基准日未收盘',
      source: 'eastmoney',
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it.each([
    { ok: false },
    { ok: true, json: async () => ({ rc: 1, data: null }) },
    history('000030'),
  ])('历史源失败不切换其他来源：%j', async (reply) => {
    fetchMock.mockResolvedValue(reply);
    expect((await service.get('2026-09-10', ['600396'])).items[0]).toMatchObject({
      dayPercent: null,
      sincePercent: null,
      source: 'eastmoney',
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it('跨日期隔离缓存，重复与并发查询复用请求，30 秒后刷新', async () => {
    mock();
    await Promise.all([
      service.get('2026-09-10', ['600396', '600396']),
      service.get('2026-09-10', ['600396']),
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await service.get('2026-09-10', ['600396']);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await service.get('2026-09-09', ['600396']);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    jest.setSystemTime(new Date('2026-10-27T02:01:31Z'));
    await service.get('2026-09-10', ['600396']);
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });
  it('跨批全局四路请求且单股失败隔离', async () => {
    let active = 0,
      peak = 0;
    fetchMock.mockImplementation(async (url: URL) => {
      const code = (url.searchParams.get('secid') ?? url.searchParams.get('secids'))!.split('.')[1];
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setImmediate(resolve));
      active--;
      if (code === '600001') throw new Error('network');
      return url.hostname === 'push2his.eastmoney.com' ? history(code) : quotes(code);
    });
    const codes = Array.from({ length: 12 }, (_, index) => String(600000 + index));
    const batches = await Promise.all([
      service.get('2026-09-10', codes.slice(0, 6)),
      service.get('2026-09-10', codes.slice(6)),
    ]);
    expect(peak).toBe(4);
    expect(
      batches
        .flatMap((batch) => batch.items)
        .filter((item) => item.sincePercent === null)
        .map((item) => item.code),
    ).toEqual(['600001']);
  });
  it('非法日期和未来日期不外呼', async () => {
    for (const date of ['2026-02-30', '2026-10-28', 'bad'])
      await expect(service.get(date, ['600396'])).rejects.toThrow('有效日期');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
