import { describe, expect, it } from 'vitest';
import {
  filterBucketsByTime,
  filterSessionsByTime,
  timeRangeWindow,
  type TimeRangeId,
} from './time-range.js';

const NOW = new Date(2026, 8, 9, 15, 30, 0); // local 2026-09-09 15:30

function iso(date: Date): string {
  return date.toISOString();
}

function local(y: number, mo: number, d: number, h = 0, mi = 0): Date {
  return new Date(y, mo, d, h, mi, 0, 0);
}

describe('timeRangeWindow', () => {
  it('today starts at local midnight and ends at the next local midnight', () => {
    const { start, end } = timeRangeWindow('today', NOW);
    expect(start).toEqual(local(2026, 8, 9, 0, 0));
    expect(end).toEqual(local(2026, 8, 10, 0, 0));
  });

  it('today is local-calendar, not UTC day', () => {
    const { start, end } = timeRangeWindow('today', NOW);
    expect(start.getHours()).toBe(0);
    expect(start.getDate()).toBe(NOW.getDate());
    expect(end.getTime() - start.getTime()).toBe(24 * 60 * 60 * 1000);
  });

  it.each<[TimeRangeId, number]>([
    ['24h', 24 * 60 * 60 * 1000],
    ['7d', 7 * 24 * 60 * 60 * 1000],
    ['30d', 30 * 24 * 60 * 60 * 1000],
    ['90d', 90 * 24 * 60 * 60 * 1000],
  ])('%s is a rolling window ending at now', (range, durationMs) => {
    const { start, end } = timeRangeWindow(range, NOW);
    expect(end).toEqual(NOW);
    expect(start.getTime()).toBe(NOW.getTime() - durationMs);
  });
});

describe('filterBucketsByTime', () => {
  it('keeps buckets whose bucketStart is inside the today window', () => {
    const window = timeRangeWindow('today', NOW);
    const insideMidnight = { bucketStart: iso(local(2026, 8, 9, 0, 0)) };
    const insideAfternoon = { bucketStart: iso(local(2026, 8, 9, 15, 0)) };
    const yesterday = { bucketStart: iso(local(2026, 8, 8, 23, 30)) };
    const tomorrow = { bucketStart: iso(local(2026, 8, 10, 0, 0)) };

    expect(
      filterBucketsByTime(
        [insideMidnight, insideAfternoon, yesterday, tomorrow],
        window,
      ),
    ).toEqual([insideMidnight, insideAfternoon]);
  });

  it('keeps a 24h bucket that started 23h ago and drops one 25h ago', () => {
    const window = timeRangeWindow('24h', NOW);
    const kept = { bucketStart: iso(new Date(NOW.getTime() - 23 * 60 * 60 * 1000)) };
    const dropped = { bucketStart: iso(new Date(NOW.getTime() - 25 * 60 * 60 * 1000)) };
    expect(filterBucketsByTime([kept, dropped], window)).toEqual([kept]);
  });

  it('does not mutate the input array', () => {
    const window = timeRangeWindow('7d', NOW);
    const buckets = [{ bucketStart: iso(NOW) }];
    const copy = [...buckets];
    filterBucketsByTime(buckets, window);
    expect(buckets).toEqual(copy);
  });
});

describe('filterSessionsByTime', () => {
  it('keeps sessions that overlap the window', () => {
    const window = timeRangeWindow('today', NOW);
    const inside = {
      firstMessageAt: iso(local(2026, 8, 9, 10, 0)),
      lastMessageAt: iso(local(2026, 8, 9, 11, 0)),
    };
    const startsYesterdayEndsToday = {
      firstMessageAt: iso(local(2026, 8, 8, 22, 0)),
      lastMessageAt: iso(local(2026, 8, 9, 1, 0)),
    };
    const whollyYesterday = {
      firstMessageAt: iso(local(2026, 8, 8, 10, 0)),
      lastMessageAt: iso(local(2026, 8, 8, 11, 0)),
    };
    const startsTomorrow = {
      firstMessageAt: iso(local(2026, 8, 10, 0, 0)),
      lastMessageAt: iso(local(2026, 8, 10, 1, 0)),
    };

    expect(
      filterSessionsByTime(
        [inside, startsYesterdayEndsToday, whollyYesterday, startsTomorrow],
        window,
      ),
    ).toEqual([inside, startsYesterdayEndsToday]);
  });

  it('treats a session with only firstMessageAt as a point in time', () => {
    const window = timeRangeWindow('today', NOW);
    const pointToday = { firstMessageAt: iso(local(2026, 8, 9, 8, 0)) };
    const pointYesterday = { firstMessageAt: iso(local(2026, 8, 8, 8, 0)) };
    expect(filterSessionsByTime([pointToday, pointYesterday], window)).toEqual([
      pointToday,
    ]);
  });
});
