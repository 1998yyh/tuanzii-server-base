import { Injectable, Logger } from '@nestjs/common';
import { assertPublicUrl } from '../common/utils/ssrf.util';

export interface Sector {
  code: string;
  name: string;
  level?: number;
}

export interface StockSectors {
  code: string;
  industries: Sector[];
  concepts: Sector[];
  status: 'ready' | 'unavailable';
  source: 'eastmoney';
  fetchedAt: string | null;
}

interface BoardRow {
  SECUCODE: string;
  SECURITY_CODE: string;
  BOARD_NAME: string;
  NEW_BOARD_CODE: string;
  BOARD_TYPE: string | null;
  BOARD_LEVEL: string | null;
  IS_PRECISE: string | null;
}

interface BoardResponse {
  success: boolean;
  result: { pages: number; data: BoardRow[] } | null;
}

const ENDPOINT = 'https://datacenter.eastmoney.com/securities/api/data/v1/get';
const CACHE_TTL = 6 * 60 * 60 * 1000;
const FAILURE_TTL = 60 * 1000;

@Injectable()
export class StockSectorsService {
  private readonly logger = new Logger(StockSectorsService.name);
  private readonly cache = new Map<string, { expires: number; item: StockSectors }>();
  private readonly pending = new Map<string, Promise<void>>();

  async get(codes: string[]) {
    const unique = [...new Set(codes)];
    const missing = unique.filter((code) => (this.cache.get(code)?.expires ?? 0) <= Date.now());
    if (missing.length) {
      const key = missing.sort().join(',');
      let job = this.pending.get(key);
      if (!job) {
        job = this.refresh(missing).finally(() => this.pending.delete(key));
        this.pending.set(key, job);
      }
      await job;
    }
    return { items: unique.map((code) => this.cache.get(code)!.item) };
  }

  private async refresh(codes: string[]) {
    try {
      const rows: BoardRow[] = [];
      let pages = 1;
      for (let page = 1; page <= pages; page++) {
        const url = new URL(ENDPOINT);
        url.search = new URLSearchParams({
          reportName: 'RPT_F10_CORETHEME_BOARDTYPE',
          columns:
            'SECUCODE,SECURITY_CODE,BOARD_NAME,BOARD_TYPE,BOARD_LEVEL,IS_PRECISE,NEW_BOARD_CODE',
          filter: `(SECUCODE in (${codes.map((code) => `"${code}.${code.startsWith('6') ? 'SH' : 'SZ'}"`).join(',')}))`,
          pageSize: '500',
          pageNumber: String(page),
        }).toString();
        await assertPublicUrl(url.href);
        const response = await fetch(url, {
          signal: AbortSignal.timeout(8000),
          redirect: 'error',
          headers: {
            'User-Agent': 'Mozilla/5.0',
            Referer: 'https://emweb.securities.eastmoney.com/',
          },
        });
        if (!response.ok) throw new Error('板块数据源请求失败');
        const body = (await response.json()) as BoardResponse;
        if (!body.success || !Array.isArray(body.result?.data)) {
          throw new Error('板块数据源返回无效数据');
        }
        pages = body.result.pages;
        if (!Number.isInteger(pages) || pages < 1 || pages > 10) {
          throw new Error('板块数据源分页异常');
        }
        rows.push(...body.result.data);
      }
      const fetchedAt = new Date().toISOString();
      for (const code of codes) {
        const symbol = `${code}.${code.startsWith('6') ? 'SH' : 'SZ'}`;
        const own = rows.filter((row) => row.SECURITY_CODE === code && row.SECUCODE === symbol);
        if (!own.length) {
          this.unavailable(code);
          continue;
        }
        const industries = new Map<string, Sector>();
        const concepts = new Map<string, Sector>();
        for (const row of own) {
          if (typeof row.BOARD_NAME !== 'string' || !row.BOARD_NAME.trim()) continue;
          if (typeof row.NEW_BOARD_CODE !== 'string' || !/^BK\d+$/.test(row.NEW_BOARD_CODE))
            continue;
          const sector: Sector = { code: row.NEW_BOARD_CODE, name: row.BOARD_NAME.trim() };
          if (row.BOARD_TYPE === '行业' && /^[123]$/.test(row.BOARD_LEVEL ?? '')) {
            sector.level = Number(row.BOARD_LEVEL);
            industries.set(sector.code, sector);
          } else if (!row.BOARD_TYPE && row.IS_PRECISE === '1') {
            // 只展示数据源明确标记的主题概念，排除地域、指数成分和交易属性。
            concepts.set(sector.code, sector);
          }
        }
        this.cache.set(code, {
          expires: Date.now() + CACHE_TTL,
          item: {
            code,
            industries: [...industries.values()].sort((a, b) => a.level! - b.level!),
            concepts: [...concepts.values()].sort((a, b) => a.code.localeCompare(b.code)),
            status: 'ready',
            source: 'eastmoney',
            fetchedAt,
          },
        });
      }
    } catch {
      this.logger.warn('板块数据源暂不可用，本批次返回缺失状态');
      for (const code of codes) this.unavailable(code);
    }
  }

  private unavailable(code: string) {
    this.cache.set(code, {
      expires: Date.now() + FAILURE_TTL,
      item: {
        code,
        industries: [],
        concepts: [],
        status: 'unavailable',
        source: 'eastmoney',
        fetchedAt: null,
      },
    });
  }
}
