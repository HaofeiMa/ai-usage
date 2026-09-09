export type TimeRangeId = 'today' | '24h' | '7d' | '30d' | '90d';

export type TimeWindow = {
  start: Date;
  end: Date;
};

const ROLLING_MS: Record<Exclude<TimeRangeId, 'today'>, number> = {
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
  '90d': 90 * 24 * 60 * 60 * 1000,
};

export function timeRangeWindow(range: TimeRangeId, now: Date): TimeWindow {
  if (range === 'today') {
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    const end = new Date(start);
    end.setDate(end.getDate() + 1);
    return { start, end };
  }

  return {
    start: new Date(now.getTime() - ROLLING_MS[range]),
    end: new Date(now),
  };
}

function toDate(value: unknown): Date | null {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  if (typeof value === 'string' || typeof value === 'number') {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  return null;
}

function inWindow(date: Date, window: TimeWindow): boolean {
  const t = date.getTime();
  return t >= window.start.getTime() && t < window.end.getTime();
}

export function filterBucketsByTime<T extends { bucketStart: string | Date }>(
  buckets: T[],
  window: TimeWindow,
): T[] {
  return buckets.filter((bucket) => {
    const start = toDate(bucket.bucketStart);
    return start ? inWindow(start, window) : false;
  });
}

export function filterSessionsByTime<
  T extends { firstMessageAt?: string | Date; lastMessageAt?: string | Date },
>(sessions: T[], window: TimeWindow): T[] {
  return sessions.filter((session) => {
    const first = toDate(session.firstMessageAt);
    if (!first) return false;
    const last = toDate(session.lastMessageAt) ?? first;
    return first.getTime() < window.end.getTime() && last.getTime() >= window.start.getTime();
  });
}

export function usesHourlyTrend(range: TimeRangeId): boolean {
  return range === 'today' || range === '24h';
}
