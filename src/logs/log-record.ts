import { HttpException } from '@nestjs/common';

export type LogLevel = 'info' | 'warn' | 'error' | 'debug' | 'fatal';
export interface LogRecord {
  id: string;
  timestamp: string;
  level: LogLevel;
  message: string;
  [key: string]: string | number | boolean | undefined;
}

const FIELDS = new Set([
  'message',
  'context',
  'event',
  'requestId',
  'conversationId',
  'agentId',
  'runId',
  'channelId',
  'apiFormat',
  'modelName',
  'searchKind',
  'upstreamHost',
  'upstreamStatus',
  'upstreamCode',
  'upstreamRequestId',
  'errorCode',
  'stack',
  'durationMs',
  'outcome',
  'method',
  'route',
  'httpStatus',
  'taskId',
  'toolCallId',
]);

/** 字段白名单之外再处理自由文本；日志不接收请求体、聊天正文或任意 SDK 对象。 */
export function redactText(input: string, maxLength = 2048): string {
  return input
    .replace(
      /((?:authorization|cookie)["']?\s*[:=]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\n]*)/gi,
      '$1[REDACTED]',
    )
    .replace(/https?:\/\/[^\s"<>]+/gi, (raw) => {
      try {
        const url = new URL(raw);
        return `${url.origin}${url.pathname}`;
      } catch {
        return '[URL]';
      }
    })
    .replace(/\b(Bearer|Basic)\s+[^\s,;"']+/gi, '$1 [REDACTED]')
    .replace(/\b(?:sk-|tvly-|tavily-)[a-z0-9_-]+/gi, '[REDACTED]')
    .replace(/\beyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+/g, '[REDACTED]')
    .replace(
      /(["']?(?:api[_-]?key|authorization|cookie|password|secret|access[_-]?token|refresh[_-]?token)["']?\s*[:=]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s,;}]+)/gi,
      '$1[REDACTED]',
    )
    .slice(0, maxLength);
}

export function sanitizeLog(
  value: Record<string, unknown>,
): Record<string, string | number | boolean> {
  const result: Record<string, string | number | boolean> = {};
  for (const [key, field] of Object.entries(value)) {
    if (!FIELDS.has(key)) continue;
    if (typeof field === 'string') result[key] = redactText(field, key === 'stack' ? 4096 : 2048);
    else if (typeof field === 'number' && Number.isFinite(field)) result[key] = field;
    else if (typeof field === 'boolean') result[key] = field;
  }
  return result;
}

export function errorFields(error: unknown): Record<string, unknown> {
  const object = error && typeof error === 'object' ? (error as Record<string, unknown>) : {};
  const response = object.response as { status?: unknown } | undefined;
  const text =
    typeof object.message === 'string'
      ? object.message
      : typeof error === 'string'
        ? error
        : '未知异常';
  let message = text;
  // SDK 常将整段 JSON 拼进 message，只取错误摘要，避免连带保存 messages/body。
  const start = text.indexOf('{');
  if (start >= 0) {
    try {
      const parsed = JSON.parse(text.slice(start)) as {
        error?: { message?: unknown };
        message?: unknown;
      };
      const summary = parsed.error?.message ?? parsed.message;
      message = typeof summary === 'string' ? summary : text.slice(0, start) + '上游返回错误';
    } catch {
      message = text.slice(0, start) + '上游返回错误（详情已省略）';
    }
  }
  const status =
    error instanceof HttpException
      ? error.getStatus()
      : (object.status ?? response?.status ?? Number(text.match(/^\s*(\d{3})\b/)?.[1]));
  return sanitizeLog({
    message,
    upstreamStatus:
      typeof status === 'number' && status >= 400 && status <= 599 ? status : undefined,
    upstreamCode: object.code,
    upstreamRequestId: object.request_id,
    // 第一行可能包含整份 SDK 响应；以已抽取的摘要替换。
    stack:
      typeof object.stack === 'string'
        ? [
            message,
            ...object.stack
              .split('\n')
              .filter((line) => /^\s+at /.test(line))
              .slice(0, 12),
          ].join('\n')
        : undefined,
  });
}
