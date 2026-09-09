import { describe, expect, it } from 'vitest';
import {
  computedTotal,
  filterBuckets,
  filterSessions,
  summaryCards,
  trayTokens,
  type View,
} from './usage.js';

const codingBucket = {
  source: 'cursor',
  inputTokens: 100,
  outputTokens: 50,
  cachedInputTokens: 20,
  reasoningOutputTokens: 10,
};

const chatgptBucket = {
  source: 'chatgpt-web',
  inputTokens: 200,
  outputTokens: 80,
  cachedInputTokens: 0,
  reasoningOutputTokens: 0,
};

const codingSession = {
  source: 'cursor',
  activeSeconds: 120,
  durationSeconds: 300,
};

const chatgptSession = {
  source: 'chatgpt-web',
  activeSeconds: 45,
  durationSeconds: 90,
};

describe('filterBuckets', () => {
  const buckets = [codingBucket, chatgptBucket];

  it('coding view drops chatgpt-web regardless of toggle', () => {
    expect(filterBuckets(buckets, 'coding', true)).toEqual([codingBucket]);
    expect(filterBuckets(buckets, 'coding', false)).toEqual([codingBucket]);
  });

  it('chatgpt view keeps only chatgpt-web regardless of toggle', () => {
    expect(filterBuckets(buckets, 'chatgpt', true)).toEqual([chatgptBucket]);
    expect(filterBuckets(buckets, 'chatgpt', false)).toEqual([chatgptBucket]);
  });

  it('all view respects includeChatgptInTotal toggle', () => {
    expect(filterBuckets(buckets, 'all', true)).toEqual(buckets);
    expect(filterBuckets(buckets, 'all', false)).toEqual([codingBucket]);
  });

  it('does not mutate the input array', () => {
    const copy = [...buckets];
    filterBuckets(copy, 'coding', true);
    expect(copy).toEqual(buckets);
  });
});

describe('filterSessions', () => {
  const sessions = [codingSession, chatgptSession];

  it('coding view drops chatgpt-web regardless of toggle', () => {
    expect(filterSessions(sessions, 'coding', true)).toEqual([codingSession]);
    expect(filterSessions(sessions, 'coding', false)).toEqual([codingSession]);
  });

  it('chatgpt view keeps only chatgpt-web regardless of toggle', () => {
    expect(filterSessions(sessions, 'chatgpt', true)).toEqual([chatgptSession]);
    expect(filterSessions(sessions, 'chatgpt', false)).toEqual([chatgptSession]);
  });

  it('all view respects includeChatgptInTotal toggle', () => {
    expect(filterSessions(sessions, 'all', true)).toEqual(sessions);
    expect(filterSessions(sessions, 'all', false)).toEqual([codingSession]);
  });

  it('does not mutate the input array', () => {
    const copy = [...sessions];
    filterSessions(copy, 'all', true);
    expect(copy).toEqual(sessions);
  });
});

describe('computedTotal', () => {
  it('sums input, output, and reasoning tokens', () => {
    expect(computedTotal(codingBucket)).toBe(160);
  });

  it('treats missing numeric fields as 0', () => {
    expect(computedTotal({ source: 'cursor' })).toBe(0);
    expect(computedTotal({ source: 'cursor', inputTokens: 5 })).toBe(5);
  });
});

describe('summaryCards', () => {
  it('aggregates token and session metrics', () => {
    expect(summaryCards([codingBucket, chatgptBucket], [codingSession, chatgptSession])).toEqual({
      totalTokens: 440,
      cachedTokens: 20,
      activeSeconds: 165,
      durationSeconds: 390,
    });
  });

  it('treats missing numeric fields as 0', () => {
    expect(summaryCards([{ source: 'cursor' }], [{ source: 'cursor' }])).toEqual({
      totalTokens: 0,
      cachedTokens: 0,
      activeSeconds: 0,
      durationSeconds: 0,
    });
  });
});

describe('trayTokens', () => {
  it('sums computedTotal plus cachedInputTokens per bucket', () => {
    expect(trayTokens([codingBucket, chatgptBucket])).toBe(460);
  });

  it('treats missing numeric fields as 0', () => {
    expect(trayTokens([{ source: 'cursor' }])).toBe(0);
  });
});
