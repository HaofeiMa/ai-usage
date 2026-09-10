import { computedTotal } from './usage.js';
import { projectKey } from './labels.js';
import type { TimeWindow } from './time-range.js';

export type TrendGranularity = 'hour' | 'day';

export type TrendPoint = {
  key: string;
  label: string;
  codingTokens: number;
  chatgptTokens: number;
  totalTokens: number;
};

const CHATGPT_SOURCE = 'chatgpt-web';

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function bucketInstant(bucket: { bucketStart: string | Date }): Date {
  return bucket.bucketStart instanceof Date
    ? bucket.bucketStart
    : new Date(bucket.bucketStart);
}

function hourKey(date: Date): { key: string; label: string } {
  const key = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}`;
  return { key, label: `${pad(date.getHours())}:00` };
}

function dayKey(date: Date): { key: string; label: string } {
  const key = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  return { key, label: `${date.getMonth() + 1}/${date.getDate()}` };
}

function emptyPoint(date: Date, granularity: TrendGranularity): TrendPoint {
  const { key, label } = granularity === 'hour' ? hourKey(date) : dayKey(date);
  return { key, label, codingTokens: 0, chatgptTokens: 0, totalTokens: 0 };
}

function filledSlots(window: TimeWindow, granularity: TrendGranularity): TrendPoint[] {
  const cursor = new Date(window.start);
  if (granularity === 'hour') cursor.setMinutes(0, 0, 0);
  else cursor.setHours(0, 0, 0, 0);
  const slots: TrendPoint[] = [];
  while (cursor.getTime() < window.end.getTime()) {
    slots.push(emptyPoint(cursor, granularity));
    if (granularity === 'hour') cursor.setHours(cursor.getHours() + 1);
    else cursor.setDate(cursor.getDate() + 1);
  }
  return slots;
}

export function tokenTrend(
  buckets: Record<string, unknown>[],
  granularity: TrendGranularity,
  window?: TimeWindow,
  includeCache = false,
): TrendPoint[] {
  const map = new Map<string, TrendPoint>();
  if (window) {
    for (const point of filledSlots(window, granularity)) map.set(point.key, point);
  }

  for (const bucket of buckets) {
    const date = bucketInstant(bucket as { bucketStart: string | Date });
    if (Number.isNaN(date.getTime())) continue;
    const { key, label } = granularity === 'hour' ? hourKey(date) : dayKey(date);
    const point =
      map.get(key) ||
      ({ key, label, codingTokens: 0, chatgptTokens: 0, totalTokens: 0 } satisfies TrendPoint);
    const tokens = computedTotal(bucket, includeCache);
    if (bucket.source === CHATGPT_SOURCE) point.chatgptTokens += tokens;
    else point.codingTokens += tokens;
    point.totalTokens = point.codingTokens + point.chatgptTokens;
    map.set(key, point);
  }

  return [...map.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

export type DistributionRow = { key: string; tokens: number };

export function distribution(
  buckets: Record<string, unknown>[],
  field: 'hostname' | 'source' | 'model' | 'project',
  includeCache = false,
): DistributionRow[] {
  const map = new Map<string, number>();
  for (const bucket of buckets) {
    const key =
      field === 'project'
        ? projectKey(typeof bucket.project === 'string' ? bucket.project : undefined)
        : String(bucket[field] ?? '') || '(unknown)';
    map.set(key, (map.get(key) || 0) + computedTotal(bucket, includeCache));
  }
  return [...map.entries()]
    .map(([key, tokens]) => ({ key, tokens }))
    .sort((a, b) => b.tokens - a.tokens || a.key.localeCompare(b.key));
}
