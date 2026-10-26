import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { And, LessThanOrEqual, MoreThan, Repository } from 'typeorm';
import { StockSignal } from './entities/stock-signal.entity';
import { StockWatchlist, WatchlistStatus } from './entities/watchlist.entity';
import { MAIN_BOARD_CODE, StockSignalsService } from './stock-signals.service';
import { STOCK_LIST } from './stock-list.data';
import type { AddWatchlistItemDto } from './dto/add-watchlist-items.dto';

/** 单用户观察池上限 */
const MAX_WATCHLIST_ITEMS = 100;

export interface AddWatchlistResult {
  /** 成功入池的代码 */
  added: string[];
  /** 非法条目（代码非主板 / 入池日期无效），回显原始输入 */
  invalid: string[];
  /** 已在池中（含本批内重复提交）的代码 */
  duplicated: string[];
  /** 因池子已满（100 只）被拒绝的代码 */
  overflow: string[];
  /** 入池后的完整池子（triggered 排前，其余按创建时间倒序） */
  items: StockWatchlist[];
  /** 新入池条目历史检查失败的代码；入池本身成功，稍后可手动重试。 */
  checkFailed: string[];
}

export interface CheckWatchlistResult {
  /** 成功读取历史信号的待观察代码数；已触发条目不重复刷新 */
  checked: number;
  failed: string[];
  /** 本次 S 评估新触发的条目数 */
  triggered: number;
  items: StockWatchlist[];
}

/**
 * 股票观察池：用户级 B 信号入池 + S 信号触发跟踪。
 *
 * S 评估（evaluateWatching）三处复用：入池即时判定 / 每日 cron / 手动 check，
 * 规则唯一：watching 行若存在同 code、value='0'（S 信号）、signal_date 晚于
 * 入池依据日的 stock_signals 行 → 置 triggered，取满足条件的最大日期。
 */
@Injectable()
export class WatchlistService {
  private readonly logger = new Logger(WatchlistService.name);
  /** 代码 → 清单项索引（名称/市场以清单为准，与 StockSignalsService 同一数据源） */
  private readonly stockMap = new Map(STOCK_LIST.map((s) => [s.code, s]));

  constructor(
    @InjectRepository(StockWatchlist)
    private readonly watchRepo: Repository<StockWatchlist>,
    @InjectRepository(StockSignal)
    private readonly signalRepo: Repository<StockSignal>,
    private readonly signalsService: StockSignalsService,
  ) {}

  /** 当前用户的池子：triggered 排前，其余按创建时间倒序 */
  async list(userId: string): Promise<StockWatchlist[]> {
    const rows = await this.watchRepo.find({ where: { userId } });
    return rows.sort((a, b) =>
      a.status === b.status
        ? b.createdAt.getTime() - a.createdAt.getTime()
        : a.status === WatchlistStatus.TRIGGERED
          ? -1
          : 1,
    );
  }

  /**
   * 批量入池：逐条校验（非法剔除）→ 去重 → 容量截断（100 只）→ 落库 → 即时 S 判定。
   * 不做整体拒绝：能入多少入多少，四类结果在响应里逐项报告。
   */
  async addItems(userId: string, items: AddWatchlistItemDto[]): Promise<AddWatchlistResult> {
    const invalid: string[] = [];
    const duplicated: string[] = [];
    const overflow: string[] = [];
    const added: string[] = [];

    const existing = await this.watchRepo.find({ where: { userId } });
    const seen = new Set(existing.map((r) => r.code));
    let count = existing.length;

    const toInsert: Array<Partial<StockWatchlist>> = [];
    for (const item of items) {
      const code = item.code.trim();
      if (!MAIN_BOARD_CODE.test(code) || !this.isRealDate(item.entrySignalDate)) {
        invalid.push(item.code);
        continue;
      }
      if (seen.has(code)) {
        duplicated.push(code);
        continue;
      }
      if (count >= MAX_WATCHLIST_ITEMS) {
        overflow.push(code);
        continue;
      }
      seen.add(code);
      count += 1;
      added.push(code);
      toInsert.push({
        userId,
        code,
        market: item.market ?? (code.startsWith('6') ? 'sh' : 'sz'),
        name: item.name?.trim() || this.stockMap.get(code)?.name || '',
        entrySignalDate: item.entrySignalDate,
      });
    }

    let checkFailed: string[] = [];
    if (toInsert.length) {
      const newRows = await this.watchRepo.save(this.watchRepo.create(toInsert));
      checkFailed = (await this.refreshAndEvaluate(newRows)).failed;
    }

    return { added, invalid, duplicated, overflow, checkFailed, items: await this.list(userId) };
  }

  /** 删除：只能删自己的；他人 id 一律 404，不泄露存在性 */
  async remove(userId: string, id: string): Promise<void> {
    const row = await this.watchRepo.findOne({ where: { id } });
    if (!row || row.userId !== userId) {
      throw new NotFoundException('观察池条目不存在');
    }
    await this.watchRepo.remove(row);
  }

  /**
   * 手动检查补齐入池依据日之后的历史 S，再按统一规则评估；已触发项保持状态。
   */
  async check(userId: string): Promise<CheckWatchlistResult> {
    const rows = await this.list(userId);
    return { ...(await this.refreshAndEvaluate(rows)), items: await this.list(userId) };
  }

  /** 定时任务直接补查所有待观察股票，不依赖当天全市场扫描是否有结果。 */
  async checkAllWatching() {
    const rows = await this.watchRepo.find({ where: { status: WatchlistStatus.WATCHING } });
    return this.refreshAndEvaluate(rows);
  }

  private async refreshAndEvaluate(rows: StockWatchlist[]) {
    const watching = rows.filter((row) => row.status === WatchlistStatus.WATCHING);
    if (!watching.length) return { checked: 0, failed: [] as string[], triggered: 0 };
    const result = await this.signalsService.refreshWatchlistHistory(watching);
    // 某只上游失败时，数据库中已确认存在的 S 仍可触发；失败代码另外报告。
    return { ...result, triggered: await this.evaluateWatching(watching) };
  }

  /**
   * S 评估（共享规则，入池即时判定 / cron / 手动 check 三处复用）：
   * 对 watching 行，若 stock_signals 存在同 code、value='0' 且 signal_date 晚于
   * 入池依据日 → 置 triggered，triggeredSignalDate 取满足条件的最大日期。
   * 不传 rows 时评估全站所有 watching 行（cron 用）。返回本次新触发数。
   * 池子规模小（单用户 ≤100），逐行查询即可，优先简单正确。
   */
  async evaluateWatching(rows?: StockWatchlist[]): Promise<number> {
    const watching = (
      rows ?? (await this.watchRepo.find({ where: { status: WatchlistStatus.WATCHING } }))
    ).filter((r) => r.status === WatchlistStatus.WATCHING);

    let triggered = 0;
    for (const row of watching) {
      const s = await this.signalRepo.findOne({
        where: {
          code: row.code,
          value: '0',
          signalDate: And(
            MoreThan(row.entrySignalDate),
            LessThanOrEqual(this.signalsService.chinaToday()),
          ),
        },
        order: { signalDate: 'DESC' },
      });
      if (!s) continue;
      const update = await this.watchRepo.update(
        { id: row.id, userId: row.userId, status: WatchlistStatus.WATCHING },
        {
          status: WatchlistStatus.TRIGGERED,
          triggeredSignalDate: s.signalDate,
        },
      );
      triggered += update.affected ?? 0;
    }
    return triggered;
  }

  /** 是否真实存在的日历日期（DTO 正则只保形状，02-30 之类在这里拦截） */
  private isRealDate(date: string): boolean {
    const d = new Date(`${date}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === date;
  }
}
