export const SCAN_HISTORY_DAYS = 30;

export function scanHistoryToday(now = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const value = (type: string) => parts.find((part) => part.type === type)!.value;
  return `${value('year')}-${value('month')}-${value('day')}`;
}

export function firstRetainedScanDate(today = scanHistoryToday()): string {
  const date = new Date(`${today}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - SCAN_HISTORY_DAYS + 1);
  return date.toISOString().slice(0, 10);
}
