import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { StockSectorsService } from 'src/stock-signals/stock-sectors.service';
import { QuerySectorsDto } from 'src/stock-signals/dto/query-sectors.dto';
import { assertPublicUrl } from 'src/common/utils/ssrf.util';

jest.mock('src/common/utils/ssrf.util', () => ({ assertPublicUrl: jest.fn() }));

describe('股票板块查询', () => {
  let service: StockSectorsService;
  let fetchMock: jest.SpyInstance;
  const row = (name: string, code: string, fields: Record<string, unknown> = {}) => ({
    SECUCODE: '000030.SZ',
    SECURITY_CODE: '000030',
    BOARD_NAME: name,
    NEW_BOARD_CODE: code,
    BOARD_TYPE: null,
    BOARD_LEVEL: null,
    IS_PRECISE: '1',
    ...fields,
  });
  const reply = (data: unknown[], pages = 1) => ({
    ok: true,
    json: async () => ({ success: true, result: { data, pages } }),
  });

  beforeEach(() => {
    service = new StockSectorsService();
    fetchMock = jest.spyOn(global, 'fetch');
    jest.mocked(assertPublicUrl).mockResolvedValue(new URL('https://datacenter.eastmoney.com'));
  });
  afterEach(() => jest.restoreAllMocks());

  it('行业按层级排序，概念去重且排除地域与交易属性', async () => {
    fetchMock.mockResolvedValue(
      reply([
        row('汽车零部件', 'BK0481', { BOARD_TYPE: '行业', BOARD_LEVEL: '2', IS_PRECISE: '0' }),
        row('汽车', 'BK1211', { BOARD_TYPE: '行业', BOARD_LEVEL: '1' }),
        row('华为汽车', 'BK0984'),
        row('华为汽车', 'BK0984'),
        row('吉林板块', 'BK0148', { BOARD_TYPE: '板块' }),
        row('融资融券', 'BK0596', { IS_PRECISE: '0' }),
        row('不合法条目', 'bad'),
        row('其他股票', 'BK0010', { SECUCODE: '600519.SH', SECURITY_CODE: '600519' }),
      ]),
    );
    const {
      items: [item],
    } = await service.get(['000030']);
    expect(item.industries.map((sector) => sector.name)).toEqual(['汽车', '汽车零部件']);
    expect(item.concepts.map((sector) => sector.name)).toEqual(['华为汽车']);
    expect(item.status).toBe('ready');
    expect(item.source).toBe('eastmoney');
    expect(item.fetchedAt).toEqual(expect.any(String));
    expect(assertPublicUrl).toHaveBeenCalled();
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ redirect: 'error' });
  });

  it('批量查询、翻页完整读取，并从缓存复用单只与重复代码', async () => {
    fetchMock.mockResolvedValueOnce(reply([row('华为汽车', 'BK0984')], 2));
    fetchMock.mockResolvedValueOnce(
      reply([row('白酒', 'BK0896', { SECUCODE: '600519.SH', SECURITY_CODE: '600519' })], 2),
    );
    const first = await service.get(['000030', '600519', '000030']);
    expect(first.items).toHaveLength(2);
    expect(first.items.every((item) => item.status === 'ready')).toBe(true);
    expect(new URL(String(fetchMock.mock.calls[1][0])).searchParams.get('pageNumber')).toBe('2');
    expect((await service.get(['600519'])).items[0].concepts[0].name).toBe('白酒');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('同批并发请求合并，避免重复取数', async () => {
    fetchMock.mockResolvedValue(reply([row('华为汽车', 'BK0984')]));
    await Promise.all([service.get(['000030']), service.get(['000030'])]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('成功响应中缺失的股票明确标记不可用，不能冒充空概念', async () => {
    fetchMock.mockResolvedValue(reply([row('华为汽车', 'BK0984')]));
    const { items } = await service.get(['000030', '600519']);
    expect(items[0].status).toBe('ready');
    expect(items[1]).toMatchObject({ status: 'unavailable', fetchedAt: null });
  });

  it.each([
    { ok: false },
    { ok: true, json: async () => ({ success: false, result: null }) },
    reply([], 99),
  ])('异常数据源响应降级且短缓存后可以恢复', async (badResponse) => {
    const clock = jest.spyOn(Date, 'now').mockReturnValue(1000);
    fetchMock.mockResolvedValueOnce(badResponse);
    expect((await service.get(['000030'])).items[0].status).toBe('unavailable');
    await service.get(['000030']);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    clock.mockReturnValue(62000);
    fetchMock.mockResolvedValueOnce(reply([row('华为汽车', 'BK0984')]));
    expect((await service.get(['000030'])).items[0].status).toBe('ready');
  });

  it('超时或网络失败不能伪造行业或概念', async () => {
    fetchMock.mockRejectedValue(new Error('timeout'));
    expect((await service.get(['000030'])).items[0]).toMatchObject({
      status: 'unavailable',
      industries: [],
      concepts: [],
    });
  });

  it('SSRF 校验失败时禁止发出请求', async () => {
    jest.mocked(assertPublicUrl).mockRejectedValueOnce(new Error('内网地址'));
    expect((await service.get(['000030'])).items[0].status).toBe('unavailable');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('成功缓存六小时后重新取数', async () => {
    const clock = jest.spyOn(Date, 'now').mockReturnValue(1000);
    fetchMock.mockResolvedValue(reply([row('华为汽车', 'BK0984')]));
    await service.get(['000030']);
    clock.mockReturnValue(1000 + 6 * 60 * 60 * 1000);
    await service.get(['000030']);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('查询 DTO 拒绝空参数、非法代码、注入内容与超限批次', async () => {
    const valid = plainToInstance(QuerySectorsDto, { codes: '000030,600519' });
    expect(await validate(valid)).toEqual([]);
    expect(valid.codes).toEqual(['000030', '600519']);
    for (const codes of [
      undefined,
      '',
      '300001',
      'abc',
      '000030.SH',
      '000030) OR 1=1',
      Array(51).fill('000030').join(','),
    ]) {
      expect((await validate(plainToInstance(QuerySectorsDto, { codes }))).length).toBeGreaterThan(
        0,
      );
    }
  });
});
