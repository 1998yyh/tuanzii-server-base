import { Injectable, Logger } from '@nestjs/common';
import type { StockListItem } from './stock-list.data';
import { assertPublicUrl } from '../common/utils/ssrf.util';

/** 单只股票当日信号抓取结果；value 为 null 表示当日无信号值 */
export interface SignalFetchResult {
  item: StockListItem;
  value: string | null;
}

export interface SignalHistoryResult {
  item: StockListItem;
  signals: Record<string, string>;
}

const API_ROOT = 'https://finance.sina.com.cn/finance/hq/upbs';
const CONCURRENCY = 12;
const TIMEOUT_MS = 10_000;

/**
 * 新浪多空信号（upbs）抓取器。
 * 原 b-signal-scanner 页面用 JSONP 逐只请求，服务端化后改为直接 HTTP：
 * 响应是 `var _touzibullbear_sh600000={...};` 形式的 JS，只解析 JSON 历史事件，不执行脚本。
 */
@Injectable()
export class SinaScannerService {
  private readonly logger = new Logger(SinaScannerService.name);

  /** 日期查询复用同一历史响应；没有该日期事件不表示没有更早的 S。 */
  async fetchOne(item: StockListItem, date: string): Promise<SignalFetchResult> {
    const { signals } = await this.fetchHistory(item);
    return { item, value: signals[date] ?? null };
  }

  /** 一次请求读取数据源返回的全部历史事件，不按日逐次请求。 */
  async fetchHistory(item: StockListItem): Promise<SignalHistoryResult> {
    const id = `${item.market}${item.code}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const url = await assertPublicUrl(`${API_ROOT}/${id}.js`);
      const res = await fetch(url, {
        signal: controller.signal,
        redirect: 'error',
        headers: {
          // 新浪财经接口校验 Referer，缺了会 403
          Referer: 'https://finance.sina.com.cn/',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      // 响应是 `var _touzibullbear_xxx={...};`（尾部可能带反爬注释 /* ... */），
      // 数据是无嵌套对象的 JSON，取第一个 { 到对应 } 即可
      const match = text.match(/=\s*(\{[^}]*\})/);
      if (!match) throw new Error('响应格式无法解析');
      const data = JSON.parse(match[1]) as Record<string, unknown>;
      const signals: Record<string, string> = {};
      for (const [key, value] of Object.entries(data)) {
        if (!/^(?:\d{4}-\d{2}-\d{2}|\d{8})$/.test(key)) continue;
        const date = key.includes('-')
          ? key
          : `${key.slice(0, 4)}-${key.slice(4, 6)}-${key.slice(6)}`;
        const parsed = new Date(`${date}T00:00:00Z`);
        if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) continue;
        if (
          (typeof value !== 'string' && typeof value !== 'number') ||
          !/^[012]$/.test(String(value))
        ) {
          throw new Error('历史信号值无效');
        }
        // 同一日期两种键并存时保持原日期查询的 ISO 键优先规则。
        if (key.includes('-') || signals[date] === undefined) signals[date] = String(value);
      }
      if (!Object.keys(signals).length) throw new Error('未获取到有效历史信号');
      return { item, signals };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * 并发扫描一批股票（默认 12 路）。单只失败不中断整体，收集到 failures。
   * onProgress 在每只完成后回调（已检查数、累计结果），供调用方更新任务进度。
   */
  async scan(
    items: StockListItem[],
    date: string,
    onProgress?: (checked: number) => void | Promise<void>,
  ): Promise<{ results: SignalFetchResult[]; failures: string[] }> {
    return this.scanItems(items, (item) => this.fetchOne(item, date), onProgress);
  }

  async scanHistory(items: StockListItem[]) {
    return this.scanItems(items, (item) => this.fetchHistory(item));
  }

  private async scanItems<T>(
    items: StockListItem[],
    fetchItem: (item: StockListItem) => Promise<T>,
    onProgress?: (checked: number) => void | Promise<void>,
  ): Promise<{ results: T[]; failures: string[] }> {
    const results: T[] = [];
    const failures: string[] = [];
    let cursor = 0;
    let checked = 0;

    const worker = async () => {
      while (cursor < items.length) {
        const item = items[cursor++];
        try {
          results.push(await fetchItem(item));
        } catch (err) {
          failures.push(`${item.market.toUpperCase()}${item.code}`);
          this.logger.debug(`抓取失败 ${item.market}${item.code}: ${(err as Error).message}`);
        }
        checked += 1;
        await onProgress?.(checked);
      }
    };

    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, worker));
    return { results, failures };
  }
}
