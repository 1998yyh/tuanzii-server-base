import type { LoggerService } from '@nestjs/common';
import type { Request, Response, NextFunction } from 'express';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { LogStore } from './log-store';
import { errorFields, sanitizeLog, type LogLevel } from './log-record';

export const logContext = new AsyncLocalStorage<Record<string, string>>();

export class FileLogger implements LoggerService {
  constructor(private readonly store: LogStore) {}
  log(message: unknown, ...params: unknown[]) {
    this.emit('info', message, params);
  }
  warn(message: unknown, ...params: unknown[]) {
    this.emit('warn', message, params);
  }
  error(message: unknown, ...params: unknown[]) {
    this.emit('error', message, params);
  }
  fatal(message: unknown, ...params: unknown[]) {
    this.emit('fatal', message, params);
  }
  debug(message: unknown, ...params: unknown[]) {
    if (process.env.NODE_ENV !== 'production') this.emit('debug', message, params);
  }
  verbose(message: unknown, ...params: unknown[]) {
    this.debug(message, ...params);
  }

  private emit(level: LogLevel, message: unknown, params: unknown[]) {
    const context = params.at(-1);
    const fields =
      message instanceof Error ||
      (['warn', 'error', 'fatal'].includes(level) && typeof message === 'string')
        ? errorFields(message)
        : typeof message === 'object' && message !== null
          ? (message as Record<string, unknown>)
          : { message: String(message) };
    const clean = sanitizeLog({
      ...logContext.getStore(),
      ...fields,
      context: typeof context === 'string' ? context : undefined,
      ...(level === 'error' && params.length > 1 && typeof params[0] === 'string'
        ? { stack: errorFields({ message: fields.message, stack: params[0] }).stack }
        : {}),
    });
    this.store.write(level, clean);
    const line = JSON.stringify({ timestamp: new Date().toISOString(), level, ...clean }) + '\n';
    // Docker stdout 仍可应急查看；文件队列失败不反向阻塞模型调用。
    if (level === 'error' || level === 'fatal') process.stderr.write(line);
    else process.stdout.write(line);
  }
}

export function requestLogging(logger: FileLogger) {
  return (request: Request, response: Response, next: NextFunction) => {
    const requestId = randomUUID();
    response.setHeader('X-Request-Id', requestId);
    logContext.run({ requestId }, () => {
      const start = Date.now();
      let finished = false;
      const done = () => {
        if (finished) return;
        finished = true;
        // 查询日志本身不制造访问日志；不记录正文、原始 URL 或 query。
        if (request.path.startsWith('/api/admin/logs')) return;
        const fields = {
          event: 'http.request.completed',
          message: '请求结束',
          requestId,
          method: request.method,
          route: typeof request.route?.path === 'string' ? request.route.path : '[未匹配路由]',
          httpStatus: response.statusCode,
          durationMs: Date.now() - start,
          outcome: response.writableFinished ? 'completed' : 'cancelled',
        };
        if (response.statusCode >= 500) logger.error(fields);
        else logger.log(fields);
      };
      response.once('finish', done);
      response.once('close', done);
      next();
    });
  };
}
