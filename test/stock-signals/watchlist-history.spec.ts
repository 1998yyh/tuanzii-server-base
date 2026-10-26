import { StockSignalsService } from 'src/stock-signals/stock-signals.service';
import { WatchlistService } from 'src/stock-signals/watchlist.service';
import { SinaScannerService } from 'src/stock-signals/sina-scanner.service';
import { type StockSignal } from 'src/stock-signals/entities/stock-signal.entity';
import { StockWatchlist, WatchlistStatus } from 'src/stock-signals/entities/watchlist.entity';
jest.mock('src/common/utils/ssrf.util', () => ({
  assertPublicUrl: jest.fn(async (url: string) => new URL(url)),
}));

describe('观察池历史补查回归', () => {
  afterEach(() => jest.restoreAllMocks());
  const item = {
    code: '600396',
    market: 'sh' as const,
    name: '华电辽能',
    entrySignalDate: '2026-09-10',
  };

  it('华电辽能 9/15 的 S 没入库且今天无事件，检查仍能补齐并触发', async () => {
    const row = {
      ...item,
      id: 'w-1',
      userId: 'test-user',
      status: WatchlistStatus.WATCHING,
      triggeredSignalDate: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as StockWatchlist;
    const stored: Partial<StockSignal>[] = [];
    const signalRepo = {
      upsert: jest.fn(async (rows: Partial<StockSignal>[]) => stored.push(...rows)),
      findOne: jest.fn(async () => stored.find((signal) => signal.value === '0') ?? null),
    };
    const watchRepo = {
      find: jest.fn(async () => [row]),
      update: jest.fn(async (_where: unknown, update: Partial<StockWatchlist>) => {
        Object.assign(row, update);
        return { affected: 1 };
      }),
    };
    const scanner = new SinaScannerService();
    jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      text: async () => 'var _touzibullbear_sh600396={"2026-09-10":"1","2026-09-15":"0"};',
    } as Response);
    const signals = new StockSignalsService({} as never, signalRepo as never, scanner);
    jest.spyOn(signals, 'chinaToday').mockReturnValue('2026-10-26');
    const service = new WatchlistService(watchRepo as never, signalRepo as never, signals);

    const first = await service.check('test-user');
    expect(first).toMatchObject({ checked: 1, failed: [], triggered: 1 });
    expect(stored).toEqual([
      expect.objectContaining({ code: '600396', signalDate: '2026-09-15', value: '0' }),
    ]);
    expect(row.status).toBe(WatchlistStatus.TRIGGERED);
    expect(row.triggeredSignalDate).toBe('2026-09-15');
    expect(await service.check('test-user')).toMatchObject({
      checked: 0,
      failed: [],
      triggered: 0,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('只存入池依据日之后且不晚于今天的 S；跨用户同股按最早日期去重取数', async () => {
    const upsert = jest.fn();
    const scanHistory = jest.fn().mockResolvedValue({
      results: [
        {
          item,
          signals: {
            '2026-09-09': '0',
            '2026-09-10': '0',
            '2026-09-15': '0',
            '2026-09-16': '1',
            '2026-09-17': '2',
            '2999-01-01': '0',
          },
        },
      ],
      failures: [],
    });
    const service = new StockSignalsService(
      {} as never,
      { upsert } as never,
      { scanHistory } as never,
    );
    jest.spyOn(service, 'chinaToday').mockReturnValue('2026-10-26');
    expect(
      await service.refreshWatchlistHistory([{ ...item, entrySignalDate: '2026-09-14' }, item]),
    ).toEqual({ checked: 1, failed: [] });
    expect(scanHistory.mock.calls[0][0]).toHaveLength(1);
    expect(upsert.mock.calls[0][0]).toEqual([
      expect.objectContaining({ signalDate: '2026-09-15', value: '0', runId: null }),
    ]);
    expect(upsert.mock.calls[0][1]).toEqual({ conflictPaths: ['signalDate', 'code'] });
  });

  it('空列表不外呼，部分失败如实报告', async () => {
    const scanHistory = jest.fn().mockResolvedValue({ results: [], failures: ['SH600396'] });
    const upsert = jest.fn();
    const service = new StockSignalsService(
      {} as never,
      { upsert } as never,
      { scanHistory } as never,
    );
    expect(await service.refreshWatchlistHistory([])).toEqual({ checked: 0, failed: [] });
    expect(scanHistory).not.toHaveBeenCalled();
    expect(await service.refreshWatchlistHistory([item])).toEqual({
      checked: 0,
      failed: ['SH600396'],
    });
    expect(upsert).not.toHaveBeenCalled();
  });
});
