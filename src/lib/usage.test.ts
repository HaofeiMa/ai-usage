import { describe, expect, it } from 'vitest';
import {
  computedTotal,
  dropCloudRows,
  filterBuckets,
  filterSessions,
  summaryCards,
  trayTokens,
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
  messageCount: 8,
};

const chatgptSession = {
  source: 'chatgpt-web',
  activeSeconds: 45,
  durationSeconds: 90,
  messageCount: 4,
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

  it('coding view keeps Codex and other non-chatgpt sources', () => {
    const codex = { source: 'codex', inputTokens: 9 };
    const claude = { source: 'claude-code', inputTokens: 4 };
    expect(filterBuckets([codex, chatgptBucket, claude], 'coding', true)).toEqual([
      codex,
      claude,
    ]);
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
    expect(computedTotal(codingBucket, false)).toBe(160);
  });

  it('can include cached input tokens in the total', () => {
    expect(computedTotal(codingBucket, true)).toBe(180);
  });

  it('treats missing numeric fields as 0', () => {
    expect(computedTotal({ source: 'cursor' })).toBe(0);
    expect(computedTotal({ source: 'cursor', inputTokens: 5 })).toBe(5);
    expect(computedTotal({ source: 'cursor', cachedInputTokens: 9 }, true)).toBe(9);
  });
});

describe('summaryCards', () => {
  it('aggregates token and session metrics', () => {
    expect(summaryCards([codingBucket, chatgptBucket], [codingSession, chatgptSession])).toEqual({
      totalTokens: 440,
      inputTokens: 300,
      outputTokens: 140,
      cachedTokens: 20,
      activeSeconds: 165,
      durationSeconds: 390,
      sessionCount: 2,
      messageCount: 12,
    });
  });

  it('adds cache into totalTokens when asked', () => {
    expect(
      summaryCards([codingBucket, chatgptBucket], [codingSession, chatgptSession], true)
        .totalTokens,
    ).toBe(460);
  });

  it('treats missing numeric fields as 0', () => {
    expect(summaryCards([{ source: 'cursor' }], [{ source: 'cursor' }])).toEqual({
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
      activeSeconds: 0,
      durationSeconds: 0,
      sessionCount: 1,
      messageCount: 0,
    });
  });
});

describe('dropCloudRows', () => {
  it('drops cursor-cloud hostname rows and keeps local device rows', () => {
    const local = { source: 'cursor', hostname: 'Huffies-Mac-mini', inputTokens: 10 };
    const cloud = { source: 'cursor', hostname: 'cursor-cloud', inputTokens: 999 };
    const other = { source: 'codex', hostname: 'Huffies-Mac-mini', inputTokens: 3 };
    expect(dropCloudRows([local, cloud, other])).toEqual([local, other]);
  });

  it('does not mutate the input array', () => {
    const rows = [{ source: 'cursor', hostname: 'cursor-cloud' }];
    dropCloudRows(rows);
    expect(rows).toHaveLength(1);
  });
});

describe('trayTokens', () => {
  it('matches the dashboard total for the same cache setting', () => {
    expect(trayTokens([codingBucket, chatgptBucket], false)).toBe(440);
    expect(trayTokens([codingBucket, chatgptBucket], true)).toBe(460);
  });

  it('treats missing numeric fields as 0', () => {
    expect(trayTokens([{ source: 'cursor' }])).toBe(0);
  });
});
