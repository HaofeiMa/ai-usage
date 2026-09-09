import { describe, expect, it } from 'vitest';
import { filterByFacets } from './facets.js';
import { tokenTrend, distribution, type TrendGranularity } from './charts.js';
import { computedTotal } from './usage.js';

describe('filterByFacets', () => {
  const rows = [
    { source: 'cursor', hostname: 'mbp', model: 'gpt-5', project: 'ai-usage' },
    { source: 'chatgpt-web', hostname: 'mbp', model: 'gpt-5', project: 'chatgpt' },
    { source: 'codex', hostname: 'linux', model: 'gpt-5', project: 'ai-usage' },
  ];

  it('empty facets keep every row', () => {
    expect(filterByFacets(rows, {})).toEqual(rows);
  });

  it('filters by hostname, source, model, and project together', () => {
    expect(
      filterByFacets(rows, {
        hostnames: ['mbp'],
        sources: ['cursor', 'chatgpt-web'],
        models: ['gpt-5'],
        projects: ['ai-usage'],
      }),
    ).toEqual([rows[0]]);
  });

  it('does not mutate the input', () => {
    const copy = [...rows];
    filterByFacets(rows, { sources: ['cursor'] });
    expect(rows).toEqual(copy);
  });

  it('keeps rows that omit a selected facet field', () => {
    const session = { source: 'cursor', project: 'ai-usage' };
    expect(filterByFacets([session], { hostnames: ['mbp'], models: ['gpt-5'] })).toEqual([
      session,
    ]);
  });
});

describe('tokenTrend', () => {
  it('groups today/24h by hour and splits chatgpt-web', () => {
    const start = new Date(2026, 8, 9, 10, 0).toISOString();
    const later = new Date(2026, 8, 9, 11, 0).toISOString();
    const buckets = [
      { source: 'cursor', bucketStart: start, inputTokens: 100, outputTokens: 0, reasoningOutputTokens: 0 },
      { source: 'chatgpt-web', bucketStart: start, inputTokens: 40, outputTokens: 0, reasoningOutputTokens: 0 },
      { source: 'codex', bucketStart: later, inputTokens: 20, outputTokens: 0, reasoningOutputTokens: 0 },
    ];
    const series = tokenTrend(buckets, 'hour');
    expect(series).toHaveLength(2);
    expect(series[0]).toMatchObject({ codingTokens: 100, chatgptTokens: 40, totalTokens: 140 });
    expect(series[1]).toMatchObject({ codingTokens: 20, chatgptTokens: 0, totalTokens: 20 });
    expect(computedTotal(buckets[0]) + 40).toBe(140);
    const granularity: TrendGranularity = 'hour';
    expect(granularity).toBe('hour');
  });

  it('groups 7d+ by local day', () => {
    const day1 = new Date(2026, 8, 8, 10, 0).toISOString();
    const day2 = new Date(2026, 8, 9, 10, 0).toISOString();
    const series = tokenTrend(
      [
        { source: 'cursor', bucketStart: day1, inputTokens: 10, outputTokens: 0, reasoningOutputTokens: 0 },
        { source: 'cursor', bucketStart: day2, inputTokens: 5, outputTokens: 0, reasoningOutputTokens: 0 },
      ],
      'day',
    );
    expect(series.map((row) => row.totalTokens)).toEqual([10, 5]);
  });
});

describe('distribution', () => {
  it('sums computedTotal by a facet key', () => {
    const buckets = [
      { source: 'cursor', model: 'a', inputTokens: 10, outputTokens: 0, reasoningOutputTokens: 0 },
      { source: 'cursor', model: 'b', inputTokens: 7, outputTokens: 0, reasoningOutputTokens: 0 },
      { source: 'chatgpt-web', model: 'a', inputTokens: 3, outputTokens: 0, reasoningOutputTokens: 0 },
    ];
    expect(distribution(buckets, 'source')).toEqual([
      { key: 'cursor', tokens: 17 },
      { key: 'chatgpt-web', tokens: 3 },
    ]);
    expect(distribution(buckets, 'model')).toEqual([
      { key: 'a', tokens: 13 },
      { key: 'b', tokens: 7 },
    ]);
  });
});
