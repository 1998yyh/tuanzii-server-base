import { BadRequestException, HttpException, ServiceUnavailableException } from '@nestjs/common';
import {
  appendFile,
  mkdir,
  readdir,
  lstat,
  open,
  rename,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { gzip, gunzip } from 'node:zlib';
import { promisify } from 'node:util';
import { sanitizeLog, type LogLevel, type LogRecord } from './log-record';

const zip = promisify(gzip);
const unzip = promisify(gunzip);
const FILE = /^app-(\d{4}-\d{2}-\d{2})-(\d{13})\.jsonl(?:\.gz)?$/;
const MAX_SEGMENT = 1024 * 1024;
const MAX_QUEUE = 1024 * 1024;
const MAX_RECORD = 16 * 1024;
export const logDate = (date = new Date()) =>
  new Date(date.getTime() + 8 * 3600_000).toISOString().slice(0, 10);
export interface LogQuery {
  date: string;
  level?: LogLevel;
  conversationId?: string;
  requestId?: string;
  limit?: number;
  cursor?: string;
}
interface LogFile {
  name: string;
  base: string;
  date: string;
  size: number;
}
interface StoreOptions {
  directory: string;
  now?: () => Date;
  segmentBytes?: number;
  maxBytes?: number;
  scanBytes?: number;
}
interface Cursor {
  file: string;
  line: number;
  filter: string;
}

/** 单进程写入，有界队列与分片；查询逐片读取，绝不解压整个日期到内存。 */
export class LogStore {
  private readonly now: () => Date;
  private readonly segmentBytes: number;
  private readonly maxBytes: number;
  private readonly scanBytes: number;
  private pending: { text: string; date: string }[] = [];
  private pendingBytes = 0;
  private worker?: Promise<void>;
  private active = '';
  private activeSize = 0;
  private sequence = Date.now();
  private ready = false;
  private closed = false;
  private querying = false;
  private timer?: NodeJS.Timeout;
  private dropped = 0;
  private writeFailed = false;

  constructor(private readonly options: StoreOptions) {
    this.now = options.now ?? (() => new Date());
    this.segmentBytes = options.segmentBytes ?? MAX_SEGMENT;
    this.maxBytes = options.maxBytes ?? 2 * 1024 ** 3;
    this.scanBytes = options.scanBytes ?? 8 * 1024 ** 2;
    if (
      this.segmentBytes < 256 ||
      this.segmentBytes > MAX_SEGMENT ||
      this.maxBytes < this.segmentBytes * 2
    )
      throw new Error('日志容量配置无效');
  }

  async initialize() {
    await mkdir(this.options.directory, { recursive: true, mode: 0o700 });
    const files = await this.files();
    for (const file of files)
      this.sequence = Math.max(this.sequence, Number(FILE.exec(file.name)![2]));
    this.ready = true;
    await this.maintain();
    this.timer = setInterval(() => {
      void this.maintain().catch(() => this.reportFailure());
    }, 60_000);
    this.timer.unref();
  }

  write(level: LogLevel, fields: Record<string, unknown>) {
    if (this.closed || !this.ready) return;
    const now = this.now();
    const clean = sanitizeLog(fields);
    const record: LogRecord = {
      ...clean,
      id: randomUUID(),
      timestamp: now.toISOString(),
      level,
      message: String(clean.message ?? ''),
    };
    let text = JSON.stringify(record) + '\n';
    if (Buffer.byteLength(text) > MAX_RECORD)
      text =
        JSON.stringify({
          id: record.id,
          timestamp: record.timestamp,
          level,
          message: record.message.slice(0, 512),
          event: 'log.record.truncated',
        }) + '\n';
    const size = Buffer.byteLength(text);
    if (this.pendingBytes + size > MAX_QUEUE) {
      this.dropped++;
      return;
    }
    this.pending.push({ text, date: logDate(now) });
    this.pendingBytes += size;
    this.startWorker();
  }

  private startWorker() {
    if (this.worker || !this.pending.length) return;
    this.worker = this.drain()
      .catch(() => this.reportFailure())
      .finally(() => {
        this.worker = undefined;
        this.startWorker();
      });
  }

  private reportFailure() {
    this.writeFailed = true;
    // 不经 Logger，避免磁盘故障触发递归；不输出文件路径或异常中的凭据。
    process.stderr.write('日志文件写入或维护失败，请检查日志存储\n');
  }

  private async drain() {
    while (this.pending.length) {
      const entry = this.pending.shift()!;
      const size = Buffer.byteLength(entry.text);
      this.pendingBytes -= size;
      try {
        if (!this.active.includes(entry.date) || this.activeSize + size > this.segmentBytes) {
          this.active = `app-${entry.date}-${++this.sequence}.jsonl`;
          this.activeSize = 0;
          await this.prune(size);
        }
        // O_NOFOLLOW 阻止同名符号链接；日志目录仅服务端可写。
        await appendFile(join(this.options.directory, this.active), entry.text, {
          mode: 0o600,
          flag: constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | constants.O_NOFOLLOW,
        });
        this.activeSize += size;
        this.writeFailed = false;
      } catch {
        this.dropped++;
        this.reportFailure();
      }
    }
  }

  async flush() {
    while (this.worker) await this.worker;
  }
  async close() {
    if (this.timer) clearInterval(this.timer);
    this.closed = true;
    await this.flush();
  }

  private oldestDate() {
    return logDate(new Date(this.now().getTime() - 13 * 86400_000));
  }
  private async files(): Promise<LogFile[]> {
    const result: LogFile[] = [];
    for (const entry of await readdir(this.options.directory, { withFileTypes: true })) {
      const match = FILE.exec(entry.name);
      if (!match || !entry.isFile()) continue;
      try {
        const stat = await lstat(join(this.options.directory, entry.name));
        if (stat.isFile())
          result.push({
            name: entry.name,
            base: entry.name.replace(/\.gz$/, ''),
            date: match[1],
            size: stat.size,
          });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    return result.sort((a, b) => a.base.localeCompare(b.base));
  }

  private async prune(reserve = 0) {
    const files = await this.files();
    let total = files.reduce((sum, file) => sum + file.size, 0);
    for (const file of files) {
      if (file.name === this.active) continue;
      if (file.date < this.oldestDate() || total + reserve + this.segmentBytes > this.maxBytes) {
        await unlink(join(this.options.directory, file.name));
        total -= file.size;
      }
    }
  }

  async maintain() {
    while (this.worker) await this.worker;
    // 与写队列共用串行 worker，压缩与轮转不会同时修改同一分片。
    if (this.closed) return;
    this.worker = this.maintenance().finally(() => {
      this.worker = undefined;
      this.startWorker();
    });
    await this.worker;
  }

  private async maintenance() {
    if (this.active && !this.active.includes(logDate(this.now()))) {
      this.active = '';
      this.activeSize = 0;
    }
    await this.prune();
    let compressedBytes = 0;
    for (const file of await this.files()) {
      if (file.date >= logDate(this.now()) || file.name.endsWith('.gz')) continue;
      const data = await this.read(file);
      const target = join(this.options.directory, file.base + '.gz');
      await writeFile(target + '.tmp', await zip(data), {
        mode: 0o600,
        flag: constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
      });
      await rename(target + '.tmp', target);
      await unlink(join(this.options.directory, file.name));
      // 每次最多压缩8MB；避免重启后补压缩大量历史日志长期占用写入队列。
      compressedBytes += data.length;
      if (compressedBytes >= 8 * MAX_SEGMENT) break;
    }
    await this.prune();
  }

  private async read(file: LogFile): Promise<Buffer> {
    let handle;
    let name = file.name;
    try {
      handle = await open(
        join(this.options.directory, name),
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || name.endsWith('.gz')) throw error;
      // 压缩采用原子替换，查询允许从刚生成的压缩副本继续。
      name += '.gz';
      handle = await open(
        join(this.options.directory, name),
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
    }
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > MAX_SEGMENT + MAX_RECORD)
        throw new ServiceUnavailableException('日志分片大小异常');
      const buffer = Buffer.alloc(stat.size);
      const { bytesRead } = await handle.read(buffer, 0, stat.size, 0);
      const data = buffer.subarray(0, bytesRead);
      return name.endsWith('.gz')
        ? await unzip(data, { maxOutputLength: MAX_SEGMENT + MAX_RECORD })
        : data;
    } finally {
      await handle.close();
    }
  }

  async status() {
    const files = await this.files();
    // 仅汇总文件元数据，不扫描或解压日志内容。
    const days = new Map<
      string,
      { date: string; totalBytes: number; compressedBytes: number; fileCount: number }
    >();
    for (const file of files) {
      const day = days.get(file.date) ?? {
        date: file.date,
        totalBytes: 0,
        compressedBytes: 0,
        fileCount: 0,
      };
      day.totalBytes += file.size;
      day.compressedBytes += file.name.endsWith('.gz') ? file.size : 0;
      day.fileCount++;
      days.set(file.date, day);
    }
    return {
      checkedAt: this.now().toISOString(),
      days: [...days.values()].sort((a, b) => b.date.localeCompare(a.date)),
      totalBytes: files.reduce((sum, file) => sum + file.size, 0),
      maxBytes: this.maxBytes,
      retentionDays: 14,
      dates: [
        ...new Set(files.filter((file) => file.date >= this.oldestDate()).map((file) => file.date)),
      ].reverse(),
      today: logDate(this.now()),
      oldestDate: this.oldestDate(),
      droppedRecords: this.dropped,
      writeFailed: this.writeFailed,
    };
  }

  async query(
    query: LogQuery,
  ): Promise<{ items: LogRecord[]; nextCursor: string | null; scanLimited: boolean }> {
    const parsed = new Date(`${query.date}T00:00:00Z`);
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(query.date) ||
      !Number.isFinite(parsed.getTime()) ||
      parsed.toISOString().slice(0, 10) !== query.date ||
      query.date < this.oldestDate() ||
      query.date > logDate(this.now())
    )
      throw new BadRequestException('请选择最近14天内的有效日期');
    if (this.querying) throw new HttpException('已有日志查询正在执行，请稍后重试', 429);
    this.querying = true;
    try {
      return await this.scan(query);
    } finally {
      this.querying = false;
    }
  }

  private async scan(query: LogQuery) {
    const limit = Math.min(Math.max(query.limit ?? 200, 1), 200);
    const filter = createHash('sha256')
      .update(JSON.stringify([query.date, query.level, query.conversationId, query.requestId]))
      .digest('hex')
      .slice(0, 16);
    let cursor: Cursor | undefined;
    if (query.cursor) {
      try {
        cursor = JSON.parse(Buffer.from(query.cursor, 'base64url').toString()) as Cursor;
        if (
          !cursor ||
          !FILE.test(cursor.file) ||
          !cursor.file.includes(query.date) ||
          !Number.isSafeInteger(cursor.line) ||
          cursor.line < 0 ||
          cursor.line > MAX_SEGMENT ||
          cursor.filter !== filter
        )
          throw new Error();
      } catch {
        throw new BadRequestException('日志游标无效，请重新查询');
      }
    }
    const files = (await this.files()).filter((file) => file.date === query.date).reverse();
    const seen = new Set<string>();
    const unique = files.filter((file) => {
      if (seen.has(file.base)) return false;
      seen.add(file.base);
      return true;
    });
    const start = cursor ? unique.findIndex((file) => file.base === cursor.file) : 0;
    if (start < 0) throw new BadRequestException('日志已轮转清理，请重新查询');
    const items: LogRecord[] = [];
    let scanned = 0;
    const deadline = Date.now() + 3000;
    const next = (file: string, line: number) =>
      Buffer.from(JSON.stringify({ file, line, filter })).toString('base64url');
    for (let index = start; index < unique.length; index++) {
      const file = unique[index];
      let data: Buffer;
      try {
        data = await this.read(file);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT')
          throw new BadRequestException('日志已清理，请重新查询');
        throw new ServiceUnavailableException('日志分片无法读取，请检查存储');
      }
      scanned += data.length;
      // 丢弃尚未写完的最后一行；后续刷新可以读到，不暴露半条 JSON。
      const lines = data.toString('utf8').split('\n');
      lines.pop();
      const last =
        index === start && cursor ? Math.min(cursor.line, lines.length - 1) : lines.length - 1;
      for (let line = last; line >= 0; line--) {
        let item: LogRecord;
        try {
          item = JSON.parse(lines[line]) as LogRecord;
        } catch {
          throw new ServiceUnavailableException('日志分片内容损坏，请检查存储');
        }
        if (!item || typeof item.id !== 'string' || typeof item.timestamp !== 'string') continue;
        if (
          (query.level && item.level !== query.level) ||
          (query.conversationId && item.conversationId !== query.conversationId) ||
          (query.requestId && item.requestId !== query.requestId)
        )
          continue;
        items.push(item);
        if (items.length >= limit)
          return {
            items,
            nextCursor:
              line > 0
                ? next(file.base, line - 1)
                : index + 1 < unique.length
                  ? next(unique[index + 1].base, MAX_SEGMENT)
                  : null,
            scanLimited: false,
          };
      }
      if ((scanned >= this.scanBytes || Date.now() >= deadline) && index + 1 < unique.length)
        return { items, nextCursor: next(unique[index + 1].base, MAX_SEGMENT), scanLimited: true };
    }
    return { items, nextCursor: null, scanLimited: false };
  }
}
