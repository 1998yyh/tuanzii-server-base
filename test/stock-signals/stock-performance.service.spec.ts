import { StockPerformanceService } from 'src/stock-signals/stock-performance.service';

jest.mock('src/common/utils/ssrf.util', () => ({
  assertPublicUrl: jest.fn(async (url: string) => new URL(url)),
}));

describe('筛选日与距今涨幅', () => {
  let service: StockPerformanceService;
  let fetchMock: jest.SpyInstance;
  const quote = (
    code = '600396',
    price: unknown = '12',
    time = '20261027100000',
    change: unknown = '3',
  ) => {
    const fields: unknown[] = Array(33).fill('');
    fields[2] = code;
    fields[3] = price;
    fields[30] = time;
    fields[32] = change;
    return fields;
  };
  const bars = [
    ['2026-09-09', '8', '8'],
    ['2026-09-10', '9', '10'],
    ['2026-10-27', '11', '12'],
  ];
  const response = (overrides: Record<string, unknown> = {}, code = '600396') => ({
    ok: true,
    json: async () => ({
      code: 0,
      data: {
        [`${code.startsWith('6') ? 'sh' : 'sz'}${code}`]: {
          qfqday: bars,
          qt: { [`${code.startsWith('6') ? 'sh' : 'sz'}${code}`]: quote(code) },
          ...overrides,
        },
      },
    }),
  });

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

  it('当日使用筛选日期而非今天，累计从该日收盘算至最新价', async () => {
    fetchMock.mockResolvedValue(response());
    const {
      items: [item],
    } = await service.get('2026-09-10', ['600396']);
    expect(item).toMatchObject({
      dayPercent: 25,
      sincePercent: 20,
      date: '2026-09-10',
      source: 'tencent',
      adjustment: 'qfq',
      dayReason: null,
      sinceReason: null,
      quoteAsOf: '2026-10-27T02:00:00.000Z',
    });
    expect(String(fetchMock.mock.calls[0][0])).toContain('qfq');
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ redirect: 'error' });
  });

  it('使用前复权价格避免除权跳变，不采用响应中的未复权 day', async () => {
    fetchMock.mockResolvedValue(
      response({
        day: [
          ['2026-09-09', '16', '16'],
          ['2026-09-10', '9', '10'],
        ],
      }),
    );
    expect((await service.get('2026-09-10', ['600396'])).items[0].dayPercent).toBe(25);
  });

  it('当前筛选日盘中有当日涨幅，但未有最终收盘基准时累计不能填零', async () => {
    fetchMock.mockResolvedValue(response());
    expect((await service.get('2026-10-27', ['600396'])).items[0]).toMatchObject({
      dayPercent: 3,
      sincePercent: null,
      sinceReason: '基准日未收盘',
    });
  });

  it('当前筛选日收盘后可计算累计真实零值', async () => {
    jest.setSystemTime(new Date('2026-10-27T07:10:00Z'));
    fetchMock.mockResolvedValue(
      response({ qt: { sh600396: quote('600396', '12', '20261027150000', '0') } }),
    );
    expect((await service.get('2026-10-27', ['600396'])).items[0]).toMatchObject({
      dayPercent: 0,
      sincePercent: 0,
      sinceReason: null,
    });
  });

  it('历史日期不自动回退到附近交易日，缺少该日时返回缺失', async () => {
    fetchMock.mockResolvedValue(response());
    expect((await service.get('2026-09-11', ['600396'])).items[0]).toMatchObject({
      dayPercent: null,
      sincePercent: null,
      dayReason: '无该日行情',
      sinceReason: '无基准日收盘价',
    });
  });

  it('缺少前一交易日不伪造日涨幅，但仍能计算距今', async () => {
    fetchMock.mockResolvedValue(response({ qfqday: bars.slice(1) }));
    expect((await service.get('2026-09-10', ['600396'])).items[0]).toMatchObject({
      dayPercent: null,
      sincePercent: 20,
      dayReason: '缺少前一交易日价格',
    });
  });

  it.each(['', '-', null, 0, 'NaN'])('无效最新价格 %j 不转换成累计零涨幅', async (price) => {
    fetchMock.mockResolvedValue(response({ qt: { sh600396: quote('600396', price) } }));
    expect((await service.get('2026-09-10', ['600396'])).items[0]).toMatchObject({
      dayPercent: 25,
      sincePercent: null,
      sinceReason: '无有效最新报价',
    });
  });

  it('停牌或非交易日保留真实报价日期，不冒充今天', async () => {
    fetchMock.mockResolvedValue(
      response({ qt: { sh600396: quote('600396', '12', '20261026150000') } }),
    );
    expect((await service.get('2026-09-10', ['600396'])).items[0]).toMatchObject({
      sincePercent: 20,
      quoteAsOf: '2026-10-26T07:00:00.000Z',
    });
  });

  it('今天只有旧报价时不冒充当日数据', async () => {
    fetchMock.mockResolvedValue(
      response({ qt: { sh600396: quote('600396', '12', '20261026150000') } }),
    );
    expect((await service.get('2026-10-27', ['600396'])).items[0]).toMatchObject({
      dayPercent: null,
      dayReason: '无当日报价',
      sincePercent: null,
    });
  });

  it.each(['20260909150000', '20261028093000', '20260230100000', 'invalid'])(
    '报价时间无效或早于基准日 %s 时累计缺失',
    async (time) => {
      fetchMock.mockResolvedValue(response({ qt: { sh600396: quote('600396', '12', time) } }));
      expect((await service.get('2026-09-10', ['600396'])).items[0].sincePercent).toBeNull();
    },
  );

  it.each([
    { qfqday: undefined, day: bars },
    { qfqday: [...bars].reverse() },
    { qfqday: [['2026-09-10', '1', '']] },
  ])('无前复权序列、乱序和非法价格均降级：%j', async (invalid) => {
    fetchMock.mockResolvedValue(response(invalid));
    expect((await service.get('2026-09-10', ['600396'])).items[0]).toMatchObject({
      dayPercent: null,
      sincePercent: null,
    });
  });

  it('批内重复与同批并发复用请求，成功缓存 30 秒，按日期隔离', async () => {
    fetchMock.mockResolvedValue(response());
    await Promise.all([
      service.get('2026-09-10', ['600396', '600396']),
      service.get('2026-09-10', ['600396']),
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await service.get('2026-09-10', ['600396']);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await service.get('2026-09-09', ['600396']);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    jest.setSystemTime(new Date('2026-10-27T02:01:31Z'));
    await service.get('2026-09-10', ['600396']);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('跨批次全局最多 4 个源站请求，失败不影响其他股票', async () => {
    let active = 0,
      peak = 0;
    fetchMock.mockImplementation(async (url: URL) => {
      const code = url.searchParams.get('param')!.slice(2, 8);
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setImmediate(resolve));
      active--;
      if (code === '600001') throw new Error('network');
      return response({}, code);
    });
    const codes = Array.from({ length: 12 }, (_, index) => String(600000 + index));
    const result = await Promise.all([
      service.get('2026-09-10', codes.slice(0, 6)),
      service.get('2026-09-10', codes.slice(6)),
    ]);
    expect(peak).toBe(4);
    expect(
      result
        .flatMap((batch) => batch.items)
        .filter((item) => item.sincePercent === null)
        .map((item) => item.code),
    ).toEqual(['600001']);
  });

  it('拒绝未来与无效日历日期，不向源站请求', async () => {
    for (const date of ['2026-02-30', '2026-10-28', 'bad'])
      await expect(service.get(date, ['600396'])).rejects.toThrow('有效日期');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
