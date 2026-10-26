import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ScanRunStatus } from './entities/scan-run.entity';
import { SinaScannerService } from './sina-scanner.service';
import { StockSignalsService } from './stock-signals.service';
import { WatchlistService } from './watchlist.service';
import type { StockListItem } from './stock-list.data';

/**
 * 全市场扫描等待上限：3044 只 / 12 并发正常几分钟跑完，留 30 分钟余量；
 * 超时放弃本轮评估（下一轮 cron 或手动 check 会补上），不无限挂住 cron。
 */
const RUN_TIMEOUT_MS = 30 * 60 * 1000;
/** 当日事件探针：只保留原全市场扫描触发条件；无当日键不能证明休市。 */
const PROBE: StockListItem = { code: '600000', market: 'sh', name: '浦发银行' };

/**
 * 观察池每日例行（Asia/Shanghai，周一至五）：
 *   10:00 早盘一轮、14:50 尾盘一轮，流程均为
 *   先独立补查全站观察池历史 S，再执行原当日扫描流程。
 * 单实例假设：与 BackgroundTasksService / GenerationPollerService 一致，多实例部署需加 leader 锁。
 */
@Injectable()
export class WatchlistCronService {
  private readonly logger = new Logger(WatchlistCronService.name);
  /** 重入保护：上一轮还没跑完（在等扫描落定）时直接跳过本轮 */
  private running = false;

  constructor(
    private readonly signalsService: StockSignalsService,
    private readonly watchlistService: WatchlistService,
    private readonly scanner: SinaScannerService,
  ) {}

  @Cron('0 10 * * 1-5', { timeZone: 'Asia/Shanghai' })
  async morningRun(): Promise<void> {
    await this.dailyFlow('10:00');
  }

  @Cron('50 14 * * 1-5', { timeZone: 'Asia/Shanghai' })
  async afternoonRun(): Promise<void> {
    await this.dailyFlow('14:50');
  }

  private async dailyFlow(label: string): Promise<void> {
    if (this.running) {
      this.logger.warn(`上一轮例行尚未结束，${label} 轮跳过`);
      return;
    }
    this.running = true;
    try {
      // 观察池先独立补查历史，不能被当日探针缺失或全市场扫描失败阻断。
      const history = await this.watchlistService.checkAllWatching();
      this.logger.log(
        `观察池 ${label} 历史检查：成功 ${history.checked} 只，新增 ${history.triggered} 项，失败 ${history.failed.length} 只`,
      );
      const today = this.signalsService.chinaToday();

      // 1. 当日事件探针只控制后续市场扫描，不能阻断已经执行的历史补查。
      //    upbs 是稀疏事件表，无当日键不能据此判断非交易日。
      let probeValue: string | null;
      try {
        probeValue = (await this.scanner.fetchOne(PROBE, today)).value;
      } catch (e) {
        this.logger.warn(`节假日探针请求失败，${label} 轮跳过: ${(e as Error).message}`);
        return;
      }
      if (probeValue === null) {
        this.logger.log(`${today} 探针无当日信号，${label} 轮跳过当日扫描；观察池历史检查已完成`);
        return;
      }

      // 2. 当日全市场扫描：cron 一律 refresh 强制重抓——14:50 轮的核心目的就是
      //    抓 10:00 之后新出现的当日信号（upsert 覆盖，历史以最新 done run 为准）；
      //    进行中的 run 仍复用，不并发重扫。分钟级异步任务，必须轮询到终态再评估
      const run = await this.signalsService.ensureMarketRun(today, true);
      const final =
        run.status === ScanRunStatus.DONE
          ? run
          : await this.signalsService.waitRunFinished(run.id, RUN_TIMEOUT_MS);
      if (final?.status !== ScanRunStatus.DONE) {
        this.logger.warn(
          `当日全市场扫描未落定（run ${run.id}，status=${final?.status ?? 'missing'}），` +
            `${label} 轮跳过 S 评估`,
        );
        return;
      }

      // 3. 全站观察池 S 评估
      const triggered = await this.watchlistService.evaluateWatching();
      this.logger.log(`观察池 ${label} 轮例行完成：新触发 ${triggered} 项`);
    } catch (e) {
      this.logger.error(`观察池 ${label} 轮例行异常`, (e as Error).stack ?? e);
    } finally {
      this.running = false;
    }
  }
}
