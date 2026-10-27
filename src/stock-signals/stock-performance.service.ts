import { BadRequestException, Injectable } from '@nestjs/common';
import { assertPublicUrl } from '../common/utils/ssrf.util';

export interface StockPerformance {
  code: string;
  date: string;
  dayPercent: number | null;
  sincePercent: number | null;
  dayReason: string | null;
  sinceReason: string | null;
  quoteAsOf: string | null;
  source: 'tencent';
  adjustment: 'qfq';
  fetchedAt: string;
}

interface TencentResponse {
  code: number;
  data?: Record<string, { qfqday?: unknown; qt?: Record<string, unknown> }>;
}

@Injectable()
export class StockPerformanceService {
  private readonly cache = new Map<string, { expires: number; item: StockPerformance }>();
  private readonly pending = new Map<string, Promise<StockPerformance>>();
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  async get(date: string, codes: string[]) {
    const parsed = new Date(`${date}T00:00:00Z`);
    const today = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
      Number.isNaN(parsed.getTime()) ||
      parsed.toISOString().slice(0, 10) !== date ||
      date > today
    ) {
      throw new BadRequestException('请选择今天或之前的有效日期');
    }
    return { items: await Promise.all([...new Set(codes)].map((code) => this.cached(date, code))) };
  }

  private cached(date: string, code: string): Promise<StockPerformance> {
    const key = `${date}:${code}`;
    const hit = this.cache.get(key);
    if (hit && hit.expires > Date.now()) return Promise.resolve(hit.item);
    const pending = this.pending.get(key);
    if (pending) return pending;
    const job = this.limited(() => this.load(date, code))
      .then((item) => {
        if (this.cache.size >= 1000) this.cache.delete(this.cache.keys().next().value!);
        this.cache.set(key, {
          expires:
            Date.now() + (item.dayPercent === null && item.sincePercent === null ? 5000 : 30000),
          item,
        });
        return item;
      })
      .finally(() => this.pending.delete(key));
    this.pending.set(key, job);
    return job;
  }

  private async limited<T>(action: () => Promise<T>): Promise<T> {
    if (this.active >= 4) await new Promise<void>((resolve) => this.waiting.push(resolve));
    else this.active++;
    try {
      return await action();
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.active--;
    }
  }

  private async load(date: string, code: string): Promise<StockPerformance> {
    const item: StockPerformance = {
      code,
      date,
      dayPercent: null,
      sincePercent: null,
      dayReason: '行情暂不可用',
      sinceReason: '行情暂不可用',
      quoteAsOf: null,
      source: 'tencent',
      adjustment: 'qfq',
      fetchedAt: new Date().toISOString(),
    };
    try {
      const symbol = `${code.startsWith('6') ? 'sh' : 'sz'}${code}`;
      const start = new Date(`${date}T00:00:00Z`);
      start.setUTCDate(start.getUTCDate() - 45);
      const url = new URL('https://web.ifzq.gtimg.cn/appstock/app/fqkline/get');
      url.searchParams.set('param', `${symbol},day,${start.toISOString().slice(0, 10)},,640,qfq`);
      await assertPublicUrl(url.href);
      const response = await fetch(url, {
        redirect: 'error',
        signal: AbortSignal.timeout(8000),
        headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://gu.qq.com/' },
      });
      if (!response.ok) return item;
      const body = (await response.json()) as TencentResponse;
      const stock = body.data?.[symbol];
      if (body.code !== 0 || !stock || !Array.isArray(stock.qfqday)) return item;
      // 不回退到未复权 day，不能把两种价格口径混算。
      const bars = stock.qfqday.map((row: unknown) => {
        if (!Array.isArray(row) || typeof row[0] !== 'string') throw new Error('日线格式无效');
        const day = row[0];
        const parsed = new Date(`${day}T00:00:00Z`);
        const close = this.price(row[2]);
        if (
          !/^\d{4}-\d{2}-\d{2}$/.test(day) ||
          Number.isNaN(parsed.getTime()) ||
          parsed.toISOString().slice(0, 10) !== day ||
          close === null
        )
          throw new Error('日线数据无效');
        return { date: day, close };
      });
      if (bars.some((bar, index) => index > 0 && bars[index - 1].date >= bar.date)) return item;
      const index = bars.findIndex((bar) => bar.date === date);
      const quote = stock.qt?.[symbol];
      const quoteTime =
        Array.isArray(quote) && quote[2] === code ? this.quoteTime(quote[30]) : null;
      const price = Array.isArray(quote) ? this.price(quote[3]) : null;
      item.quoteAsOf = quoteTime;
      const quoteDate = quoteTime
        ? new Date(new Date(quoteTime).getTime() + 8 * 3600000).toISOString().slice(0, 10)
        : null;
      const now = new Date(Date.now() + 8 * 3600000);
      const today = now.toISOString().slice(0, 10);
      const quoteClock = quoteTime
        ? new Date(new Date(quoteTime).getTime() + 8 * 3600000).toISOString().slice(11, 16)
        : '';
      const unclosed =
        date === today &&
        (now.toISOString().slice(11, 16) < '15:00' || quoteDate !== date || quoteClock < '15:00');
      if (index < 0) {
        item.dayReason = '无该日行情';
        item.sinceReason = '无基准日收盘价';
        return item;
      }
      const baseline = bars[index];
      if (date === today) {
        const percent = quoteDate === date && Array.isArray(quote) ? this.number(quote[32]) : null;
        if (percent !== null && price !== null) {
          item.dayPercent = percent;
          item.dayReason = null;
        } else item.dayReason = '无当日报价';
      } else if (index > 0) {
        item.dayPercent = this.percent(baseline.close, bars[index - 1].close);
        item.dayReason = null;
      } else item.dayReason = '缺少前一交易日价格';

      if (unclosed) item.sinceReason = '基准日未收盘';
      else if (!quoteTime || !quoteDate || quoteDate < date || price === null)
        item.sinceReason = '无有效最新报价';
      else {
        item.sincePercent = this.percent(price, baseline.close);
        item.sinceReason = null;
      }
      item.fetchedAt = new Date().toISOString();
      return item;
    } catch {
      return item;
    }
  }

  private number(value: unknown): number | null {
    if ((typeof value !== 'string' && typeof value !== 'number') || String(value).trim() === '')
      return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  private price(value: unknown) {
    const valueOf = this.number(value);
    return valueOf !== null && valueOf > 0 ? valueOf : null;
  }

  private percent(value: number, base: number) {
    const percent = Math.round((value / base - 1) * 10000) / 100;
    return Object.is(percent, -0) ? 0 : percent;
  }

  private quoteTime(value: unknown): string | null {
    if (typeof value !== 'string' || !/^\d{14}$/.test(value)) return null;
    const date = `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
    const parsed = new Date(
      `${date}T${value.slice(8, 10)}:${value.slice(10, 12)}:${value.slice(12)}+08:00`,
    );
    if (
      Number.isNaN(parsed.getTime()) ||
      parsed.getTime() > Date.now() + 60000 ||
      new Date(parsed.getTime() + 8 * 3600000).toISOString().slice(0, 10) !== date
    )
      return null;
    return parsed.toISOString();
  }
}
