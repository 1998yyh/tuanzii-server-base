import { And, LessThanOrEqual, MoreThan, type Repository } from 'typeorm';
import { StockSignal } from './entities/stock-signal.entity';
import { StockWatchlist, WatchlistStatus } from './entities/watchlist.entity';

/** Shared by fresh scans, manual checks and cron; confirmed triggers remain locked. */
export async function evaluateWatchlist(
  rows: StockWatchlist[],
  watchRepo: Repository<StockWatchlist>,
  signalRepo: Repository<StockSignal>,
  today: string,
): Promise<number> {
  let triggered = 0;
  for (const row of rows) {
    if (row.status !== WatchlistStatus.WATCHING) continue;
    const signal = await signalRepo.findOne({
      where: {
        code: row.code,
        value: '0',
        signalDate: And(MoreThan(row.entrySignalDate), LessThanOrEqual(today)),
      },
      order: { signalDate: 'DESC' },
    });
    if (!signal) continue;
    const update = await watchRepo.update(
      { id: row.id, userId: row.userId, status: WatchlistStatus.WATCHING },
      { status: WatchlistStatus.TRIGGERED, triggeredSignalDate: signal.signalDate },
    );
    triggered += update.affected ?? 0;
  }
  return triggered;
}
