import 'reflect-metadata';
import { MODULE_METADATA } from '@nestjs/common/constants';
import { DataSource, FindOperator } from 'typeorm';
import { StockScanRetentionService } from 'src/stock-signals/stock-scan-retention.service';
import { StockSignalsModule } from 'src/stock-signals/stock-signals.module';
import { StockSignalScanRun, ScanRunStatus } from 'src/stock-signals/entities/scan-run.entity';
import { StockSignal } from 'src/stock-signals/entities/stock-signal.entity';
import { firstRetainedScanDate, scanHistoryToday } from 'src/stock-signals/scan-history-window';

describe('扫描记录 30 天保留策略', () => {
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('上海跨日、30 天边界、跨年与闰年使用日历日期', () => {
    expect(scanHistoryToday(new Date('2026-10-26T16:00:00Z'))).toBe('2026-10-27');
    expect(firstRetainedScanDate('2026-10-27')).toBe('2026-09-28');
    expect(firstRetainedScanDate('2026-01-01')).toBe('2025-12-03');
    expect(firstRetainedScanDate('2024-03-01')).toBe('2024-02-01');
    expect(Reflect.getMetadata(MODULE_METADATA.PROVIDERS, StockSignalsModule)).toContain(
      StockScanRetentionService,
    );
  });

  function fixture() {
    jest.useFakeTimers().setSystemTime(new Date('2026-10-27T00:10:00+08:00'));
    const runs: Record<string, unknown>[] = [
      { id: 'old-done', queryDate: '2026-09-27', status: ScanRunStatus.DONE },
      { id: 'old-failed', queryDate: '2026-09-26', status: ScanRunStatus.FAILED },
      { id: 'boundary', queryDate: '2026-09-28', status: ScanRunStatus.DONE },
      { id: 'recent', queryDate: '2026-10-27', status: ScanRunStatus.DONE },
      { id: 'active', queryDate: '2026-09-25', status: ScanRunStatus.RUNNING },
      { id: 'active-date-done', queryDate: '2026-09-25', status: ScanRunStatus.DONE },
      { id: 'pending', queryDate: '2026-09-24', status: ScanRunStatus.PENDING },
    ];
    const signals: Record<string, unknown>[] = [
      { id: 'old-b', signalDate: '2026-09-27', value: '1', runId: 'old-done' },
      { id: 'old-empty', signalDate: '2026-09-26', value: '', runId: null },
      { id: 'old-s', signalDate: '2026-09-27', value: '0', runId: 'old-done' },
      { id: 'old-watchlist-s', signalDate: '2026-08-01', value: '0', runId: null },
      { id: 'boundary-b', signalDate: '2026-09-28', value: '1', runId: 'boundary' },
      { id: 'active-b', signalDate: '2026-09-25', value: '1', runId: 'active' },
      { id: 'active-s', signalDate: '2026-09-25', value: '0', runId: 'active' },
      { id: 'pending-b', signalDate: '2026-09-24', value: '1', runId: 'pending' },
    ];
    const matchesValue = (actual: unknown, criterion: unknown): boolean => {
      if (!(criterion instanceof FindOperator)) return actual === criterion;
      const value = criterion.value;
      switch (criterion.type) {
        case 'lessThan':
          return String(actual) < value;
        case 'in':
          return value.includes(actual);
        case 'not':
          return !matchesValue(actual, criterion.child ?? value);
        case 'and':
          return value.every((entry: unknown) => matchesValue(actual, entry));
        case 'isNull':
          return actual === null;
        default:
          throw new Error(`未实现的测试 ORM 运算符 ${criterion.type}`);
      }
    };
    const repo = (rows: Record<string, unknown>[]) => {
      const matches = (row: Record<string, unknown>, where: Record<string, unknown>) =>
        Object.entries(where).every(([key, criterion]) => matchesValue(row[key], criterion));
      return {
        find: jest.fn(async ({ where }: { where: Record<string, unknown> }) =>
          rows.filter((row) => matches(row, where)),
        ),
        update: jest.fn(async (where: Record<string, unknown>, patch: Record<string, unknown>) => {
          const entries = rows.filter((row) => matches(row, where));
          entries.forEach((row) => Object.assign(row, patch));
          return { affected: entries.length };
        }),
        delete: jest.fn(async (where: Record<string, unknown>) => {
          let affected = 0;
          for (let i = rows.length - 1; i >= 0; i--)
            if (matches(rows[i], where)) {
              rows.splice(i, 1);
              affected++;
            }
          return { affected };
        }),
      };
    };
    const runRepo = repo(runs),
      signalRepo = repo(signals);
    const transaction = jest.fn(
      async (
        work: (manager: { getRepository: (entity: unknown) => typeof runRepo }) => Promise<unknown>,
      ) => {
        const snapshot = [structuredClone(runs), structuredClone(signals)];
        try {
          return await work({
            getRepository: (entity: unknown) => {
              if (entity === StockSignalScanRun) return runRepo;
              if (entity === StockSignal) return signalRepo;
              throw new Error('清理不应访问其他表');
            },
          });
        } catch (error) {
          runs.splice(0, runs.length, ...snapshot[0]);
          signals.splice(0, signals.length, ...snapshot[1]);
          throw error;
        }
      },
    );
    const service = new StockScanRetentionService({ transaction } as unknown as DataSource);
    jest.spyOn(service['logger'], 'log').mockImplementation(() => undefined);
    jest.spyOn(service['logger'], 'error').mockImplementation(() => undefined);
    return { service, transaction, runs, signals, runRepo, signalRepo };
  }

  it('启动即清理过期终态任务与 B/空缓存，保留边界、S 事件及整个进行中日期', async () => {
    const { service, runs, signals } = fixture();
    await service.onApplicationBootstrap();
    expect(runs.map((row) => row.id)).toEqual([
      'boundary',
      'recent',
      'active',
      'active-date-done',
      'pending',
    ]);
    expect(signals.map((row) => row.id)).toEqual([
      'old-s',
      'old-watchlist-s',
      'boundary-b',
      'active-b',
      'active-s',
      'pending-b',
    ]);
    expect(signals.find((row) => row.id === 'old-s')?.runId).toBeNull();
    expect(signals.find((row) => row.id === 'active-s')?.runId).toBe('active');
    await service.cleanup();
    expect(runs).toHaveLength(5); // 重复清理幂等。
  });

  it('进行中任务完成后，下一轮清理其过期数据', async () => {
    const { service, runs, signals } = fixture();
    await service.cleanup();
    runs.find((row) => row.id === 'active')!.status = ScanRunStatus.DONE;
    await service.cleanup();
    expect(runs.some((row) => row.queryDate === '2026-09-25')).toBe(false);
    expect(signals.some((row) => row.id === 'active-b')).toBe(false);
    expect(signals.find((row) => row.id === 'active-s')?.runId).toBeNull();
  });

  it('失败回滚且可重试，不阻断服务启动', async () => {
    const { service, runs, signals, runRepo } = fixture();
    const before = structuredClone({ runs, signals });
    runRepo.delete.mockRejectedValueOnce(new Error('database failure'));
    await expect(service.onApplicationBootstrap()).resolves.toBeUndefined();
    expect({ runs, signals }).toEqual(before);
    expect(service['logger'].error).toHaveBeenCalled();
    await service.cleanup();
    expect(runs.some((row) => row.id === 'old-done')).toBe(false);
  });

  it('上一轮未结束时跳过重复执行，结束后恢复', async () => {
    const { service, transaction } = fixture();
    let release!: () => void;
    transaction.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ runs: 0, signals: 0, detached: 0, protectedDates: 0 });
        }),
    );
    const first = service.cleanup();
    await service.cleanup();
    expect(transaction).toHaveBeenCalledTimes(1);
    release();
    await first;
    await service.cleanup();
    expect(transaction).toHaveBeenCalledTimes(2);
  });
});
