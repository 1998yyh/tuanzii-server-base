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
  source: 'eastmoney';
  adjustment: 'qfq';
  fetchedAt: string;
}

interface EastmoneyHistory {
  rc: number;
  data: { code: string; klines: unknown } | null;
}

interface EastmoneyQuotes {
  rc: number;
  data: Record<string, unknown> | null;
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
      source: 'eastmoney',
      adjustment: 'qfq',
      fetchedAt: new Date().toISOString(),
    };
    try {
      const market = code.startsWith('6') ? 1 : 0;
      const start = new Date(`${date}T00:00:00Z`);
      start.setUTCDate(start.getUTCDate() - 45);
      const quoteUrl = new URL('https://push2.eastmoney.com/api/qt/stock/get');
      quoteUrl.search = new URLSearchParams({
        fltt: '2',
        invt: '2',
        fields: 'f43,f57,f86,f170',
        secid: `${market}.${code}`,
      }).toString();
      let quote: Record<string, unknown> | undefined;
      try {
        const body = (await this.json(quoteUrl)) as EastmoneyQuotes;
        if (body.rc === 0 && body.data?.f57 === code) quote = body.data;
      } catch {
        /* 历史涨幅仍可独立展示，不混用其他来源。 */
      }
      const quoteTime = this.quoteTime(quote?.f86);
      const price = this.price(quote?.f43);
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
      if (date === today) {
        const day = quoteDate === date ? this.number(quote?.f170) : null;
        if (day !== null && price !== null) {
          item.dayPercent = day;
          item.dayReason = null;
        } else item.dayReason = '无当日报价';
        if (unclosed) item.sinceReason = '基准日未收盘';
      }
      const historyUrl = new URL('https://push2his.eastmoney.com/api/qt/stock/kline/get');
      historyUrl.search = new URLSearchParams({
        secid: `${market}.${code}`,
        fields1: 'f1,f2,f3',
        fields2: 'f51,f52,f53,f54,f55,f56,f57,f58,f59',
        klt: '101',
        fqt: '1',
        beg: start.toISOString().slice(0, 10).replace(/-/g, ''),
        end: '20500101',
        lmt: '1200',
      }).toString();
      const history = (await this.json(historyUrl)) as EastmoneyHistory;
      if (history.rc !== 0 || history.data?.code !== code || !Array.isArray(history.data.klines))
        return item;
      const bars = history.data.klines.map((line: unknown) => {
        if (typeof line !== 'string') throw new Error('日线格式无效');
        const fields = line.split(',');
        const day = fields[0];
        const parsed = new Date(`${day}T00:00:00Z`);
        const close = this.price(fields[2]);
        if (
          !/^\d{4}-\d{2}-\d{2}$/.test(day) ||
          Number.isNaN(parsed.getTime()) ||
          parsed.toISOString().slice(0, 10) !== day ||
          close === null
        )
          throw new Error('日线数据无效');
        return { date: day, close, dayPercent: this.number(fields[8]) };
      });
      if (bars.some((bar, index) => index > 0 && bars[index - 1].date >= bar.date)) return item;
      const index = bars.findIndex((bar) => bar.date === date);
      if (index < 0) {
        if (date !== today || item.dayPercent === null) item.dayReason = '无该日行情';
        item.sinceReason = unclosed ? '基准日未收盘' : '无基准日收盘价';
        return item;
      }
      const baseline = bars[index];
      if (date !== today) {
        if (baseline.dayPercent !== null) {
          item.dayPercent = baseline.dayPercent;
          item.dayReason = null;
        } else item.dayReason = '缺少当日涨幅';
      }

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
    const seconds = this.number(value);
    if (seconds === null || seconds <= 0) return null;
    const parsed = new Date(seconds * 1000);
    if (!Number.isFinite(parsed.getTime()) || parsed.getTime() > Date.now() + 60000) return null;
    return parsed.toISOString();
  }

  private async json(url: URL): Promise<unknown> {
    await assertPublicUrl(url.href);
    const response = await fetch(url, {
      redirect: 'error',
      signal: AbortSignal.timeout(8000),
      headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://quote.eastmoney.com/' },
    });
    if (!response.ok) throw new Error('东方财富行情请求失败');
    return response.json();
  }
}
