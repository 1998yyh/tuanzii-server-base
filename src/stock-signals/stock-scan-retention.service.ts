import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectDataSource } from '@nestjs/typeorm';
import { And, DataSource, In, IsNull, LessThan, Not } from 'typeorm';
import { ScanRunStatus, StockSignalScanRun } from './entities/scan-run.entity';
import { StockSignal } from './entities/stock-signal.entity';
import { firstRetainedScanDate } from './scan-history-window';

/** 单实例定期清理扫描缓存；观察池 S 事件不属于可过期的扫描缓存。 */
@Injectable()
export class StockScanRetentionService implements OnApplicationBootstrap {
  private readonly logger = new Logger(StockScanRetentionService.name);
  private running = false;

  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async onApplicationBootstrap(): Promise<void> {
    // bootstrap 晚于 onModuleInit，遗留扫描已先恢复为 failed。
    await this.cleanup();
  }

  @Cron('10 0 * * *', { timeZone: 'Asia/Shanghai', waitForCompletion: true })
  async cleanup(): Promise<void> {
    if (this.running) return;
    this.running = true;
    const cutoff = firstRetainedScanDate();
    try {
      const result = await this.dataSource.transaction(async (manager) => {
        const runs = manager.getRepository(StockSignalScanRun);
        const signals = manager.getRepository(StockSignal);
        const active = await runs.find({
          select: { queryDate: true },
          where: {
            queryDate: LessThan(cutoff),
            status: In([ScanRunStatus.PENDING, ScanRunStatus.RUNNING]),
          },
        });
        const protectedDates = [...new Set(active.map((run) => run.queryDate))];
        const expired = protectedDates.length
          ? And(LessThan(cutoff), Not(In(protectedDates)))
          : LessThan(cutoff);
        // 保留既有历史 S 判定依据，但移除其已过期扫描任务关联。
        const detached = await signals.update(
          { signalDate: expired, value: '0', runId: Not(IsNull()) },
          { runId: null },
        );
        const removedSignals = await signals.delete({ signalDate: expired, value: Not('0') });
        const removedRuns = await runs.delete({
          queryDate: expired,
          status: In([ScanRunStatus.DONE, ScanRunStatus.FAILED]),
        });
        return {
          signals: removedSignals.affected ?? 0,
          runs: removedRuns.affected ?? 0,
          detached: detached.affected ?? 0,
          protectedDates: protectedDates.length,
        };
      });
      this.logger.log(
        `扫描记录清理：保留 ${cutoff} 起，删除 ${result.runs} 个任务、${result.signals} 条缓存，` +
          `保留并解除 ${result.detached} 条历史 S 的任务关联，跳过 ${result.protectedDates} 个进行中日期`,
      );
    } catch (error) {
      this.logger.error('扫描记录清理失败，事务回滚，下一轮重试', (error as Error).stack);
    } finally {
      this.running = false;
    }
  }
}
