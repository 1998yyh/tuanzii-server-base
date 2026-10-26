import { WatchlistCronService } from 'src/stock-signals/watchlist-cron.service';

describe('观察池定时历史检查', () => {
  it.each(['无当日事件', '探针失败', '市场扫描失败'])('%s 不能阻断观察池历史补查', async (mode) => {
    const checkAllWatching = jest.fn().mockResolvedValue({ checked: 1, triggered: 1, failed: [] });
    const evaluateWatching = jest.fn();
    const fetchOne =
      mode === '探针失败'
        ? jest.fn().mockRejectedValue(new Error('network'))
        : jest.fn().mockResolvedValue({ value: mode === '无当日事件' ? null : '1' });
    const ensureMarketRun = jest.fn().mockRejectedValue(new Error('market failed'));
    const service = new WatchlistCronService(
      { chinaToday: () => '2026-10-26', ensureMarketRun } as never,
      { checkAllWatching, evaluateWatching } as never,
      { fetchOne } as never,
    );
    jest.spyOn(service['logger'], 'log').mockImplementation(() => undefined);
    jest.spyOn(service['logger'], 'warn').mockImplementation(() => undefined);
    jest.spyOn(service['logger'], 'error').mockImplementation(() => undefined);
    await service.morningRun();
    expect(checkAllWatching).toHaveBeenCalledTimes(1);
    expect(checkAllWatching.mock.invocationCallOrder[0]).toBeLessThan(
      fetchOne.mock.invocationCallOrder[0],
    );
    expect(evaluateWatching).not.toHaveBeenCalled();
    jest.restoreAllMocks();
  });
});
