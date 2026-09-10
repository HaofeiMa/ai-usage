import { describe, expect, it } from 'vitest';
import { costBreakdown, formatMoney } from './billing.js';

const cursorApi = {
  source: 'cursor',
  model: 'composer-1.5',
  inputTokens: 1_000_000,
  outputTokens: 500_000,
  reasoningOutputTokens: 100_000,
  cachedInputTokens: 9_000_000,
};

const chatgptApi = {
  source: 'chatgpt-web',
  model: 'gpt-5',
  inputTokens: 2_000_000,
  outputTokens: 0,
  reasoningOutputTokens: 0,
  cachedInputTokens: 0,
};

describe('formatMoney', () => {
  it('renders USD and CNY with two decimals', () => {
    expect(formatMoney(20, 'USD')).toBe('$20.00');
    expect(formatMoney(20, 'CNY')).toBe('¥20.00');
  });
});

describe('costBreakdown', () => {
  it('uses filled monthly fees for subscription tools and does not scale by tokens', () => {
    const result = costBreakdown({
      buckets: [
        { ...cursorApi, inputTokens: 1 },
        { source: 'claude-code', inputTokens: 1 },
      ],
      billing: {
        cursor: { kind: 'subscription', monthly: 20 },
        'claude-code': { kind: 'subscription', monthly: 20 },
      },
      includeChatgptInTotal: true,
      currency: 'USD',
    });
    expect(result.coding.subscription).toBe(40);
    expect(result.coding.api).toBe(0);
    expect(result.total.subscription).toBe(40);
  });

  it('charges API tools by input+output+reasoning excluding cache', () => {
    const result = costBreakdown({
      buckets: [cursorApi],
      billing: {
        cursor: { kind: 'api', inputPerMillion: 3, outputPerMillion: 15 },
      },
      includeChatgptInTotal: true,
      currency: 'USD',
    });
    // 1M * 3 + (0.5M + 0.1M) * 15 = 3 + 9 = 12
    expect(result.coding.api).toBe(12);
    expect(result.coding.subscription).toBe(0);
    expect(result.coding.unpriced).toEqual([]);
  });

  it('marks missing API rates as unpriced and omits them from the total', () => {
    const result = costBreakdown({
      buckets: [{ source: 'alma', model: 'mystery', inputTokens: 1000, outputTokens: 10 }],
      billing: { alma: { kind: 'api' } },
      includeChatgptInTotal: true,
      currency: 'USD',
    });
    expect(result.coding.api).toBe(0);
    expect(result.coding.unpriced).toEqual(['alma']);
    expect(result.total.api).toBe(0);
  });

  it('treats free tools as zero', () => {
    const result = costBreakdown({
      buckets: [cursorApi],
      billing: { cursor: { kind: 'free' } },
      includeChatgptInTotal: true,
      currency: 'USD',
    });
    expect(result.coding).toMatchObject({ subscription: 0, api: 0, unpriced: [] });
  });

  it('keeps ChatGPT API in the chatgpt row always, but drops it from all when the toggle is off', () => {
    const resultOn = costBreakdown({
      buckets: [cursorApi, chatgptApi],
      billing: {
        cursor: { kind: 'subscription', monthly: 20 },
        'chatgpt-web': { kind: 'api', inputPerMillion: 2, outputPerMillion: 8 },
      },
      includeChatgptInTotal: true,
      currency: 'USD',
    });
    expect(resultOn.chatgpt.api).toBe(4);
    expect(resultOn.total.api).toBe(4);
    expect(resultOn.total.subscription).toBe(20);

    const resultOff = costBreakdown({
      buckets: [cursorApi, chatgptApi],
      billing: {
        cursor: { kind: 'subscription', monthly: 20 },
        'chatgpt-web': { kind: 'api', inputPerMillion: 2, outputPerMillion: 8 },
      },
      includeChatgptInTotal: false,
      currency: 'USD',
    });
    expect(resultOff.chatgpt.api).toBe(4);
    expect(resultOff.total.api).toBe(0);
    expect(resultOff.total.subscription).toBe(20);
  });

  it('counts a subscription source once even when two hostnames appear', () => {
    const result = costBreakdown({
      buckets: [
        { source: 'cursor', hostname: 'mbp', inputTokens: 1 },
        { source: 'cursor', hostname: 'linux', inputTokens: 1 },
      ],
      billing: { cursor: { kind: 'subscription', monthly: 20 } },
      includeChatgptInTotal: true,
      currency: 'USD',
    });
    expect(result.coding.subscription).toBe(20);
  });

  it('sums API tokens across hostnames', () => {
    const result = costBreakdown({
      buckets: [
        { source: 'codex', hostname: 'mbp', inputTokens: 1_000_000, outputTokens: 0 },
        { source: 'codex', hostname: 'linux', inputTokens: 1_000_000, outputTokens: 0 },
      ],
      billing: { codex: { kind: 'api', inputPerMillion: 2, outputPerMillion: 2 } },
      includeChatgptInTotal: true,
      currency: 'USD',
    });
    expect(result.coding.api).toBe(4);
  });
});
