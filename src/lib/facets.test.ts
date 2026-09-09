import { describe, expect, it } from 'vitest';
import { filterByFacets, filterSessionsByFacets } from './facets.js';
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

  it('drops rows that omit a selected facet field', () => {
    const session = { source: 'cursor', project: 'ai-usage' };
    const matching = { source: 'cursor', project: 'ai-usage', hostname: 'mbp', model: 'gpt-5' };
    expect(filterByFacets([session, matching], { hostnames: ['mbp'], models: ['gpt-5'] })).toEqual([
      matching,
    ]);
  });
});

describe('filterSessionsByFacets', () => {
  it('does not drop sessions that omit model when a model facet is selected', () => {
    const session = {
      source: 'cursor',
      hostname: 'mbp',
      project: 'ai-usage',
      durationSeconds: 90,
      activeSeconds: 40,
    };
    expect(
      filterSessionsByFacets([session], {
        hostnames: ['mbp'],
        sources: ['cursor'],
        models: ['gpt-5'],
        projects: ['ai-usage'],
      }),
    ).toEqual([session]);
  });

  it('still filters sessions by hostname, source, and project', () => {
    const keep = { source: 'cursor', hostname: 'mbp', project: 'ai-usage', durationSeconds: 90 };
    const otherHost = { source: 'cursor', hostname: 'linux', project: 'ai-usage', durationSeconds: 30 };
    const otherProject = { source: 'cursor', hostname: 'mbp', project: 'other', durationSeconds: 15 };
    expect(
      filterSessionsByFacets([keep, otherHost, otherProject], {
        hostnames: ['mbp'],
        models: ['gpt-5'],
        projects: ['ai-usage'],
      }),
    ).toEqual([keep]);
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
