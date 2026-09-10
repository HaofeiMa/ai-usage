import { sourceLabel } from './labels.js';

export type Currency = 'USD' | 'CNY';
export type BillingKind = 'subscription' | 'api' | 'free';

export type SourceBilling = {
  kind: BillingKind;
  monthly?: number;
  inputPerMillion?: number;
  outputPerMillion?: number;
};

export type BillingConfig = Record<string, SourceBilling | undefined>;

export type CostLine = {
  subscription: number;
  api: number;
  unpriced: string[];
};

export type CostBreakdown = {
  coding: CostLine;
  chatgpt: CostLine;
  total: CostLine;
  currency: Currency;
};

const CHATGPT_SOURCE = 'chatgpt-web';

type TokenBucket = {
  source: string;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  reasoningOutputTokens?: number;
  cachedInputTokens?: number;
};

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function money(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export function formatMoney(amount: number, currency: Currency): string {
  const value = Number.isFinite(amount) ? amount : 0;
  const formatted = value.toFixed(2);
  return currency === 'CNY' ? `¥${formatted}` : `$${formatted}`;
}

function billableTokens(bucket: TokenBucket): { input: number; output: number } {
  return {
    input: num(bucket.inputTokens),
    output: num(bucket.outputTokens) + num(bucket.reasoningOutputTokens),
  };
}

function uniqueSources(buckets: TokenBucket[]): string[] {
  const seen = new Set<string>();
  for (const bucket of buckets) {
    if (bucket.source) seen.add(bucket.source);
  }
  return [...seen];
}

function apiAmount(source: string, buckets: TokenBucket[], cfg: SourceBilling): number | null {
  const inputRate = money(cfg.inputPerMillion);
  const outputRate = money(cfg.outputPerMillion);
  if (inputRate <= 0 && outputRate <= 0) return null;

  const inRate = inputRate > 0 ? inputRate : outputRate;
  const outRate = outputRate > 0 ? outputRate : inputRate;
  let amount = 0;
  for (const bucket of buckets.filter((item) => item.source === source)) {
    const { input, output } = billableTokens(bucket);
    amount += (input * inRate + output * outRate) / 1_000_000;
  }
  return amount;
}

function costLine(buckets: TokenBucket[], billing: BillingConfig): CostLine {
  let subscription = 0;
  let api = 0;
  const unpriced: string[] = [];

  for (const source of uniqueSources(buckets)) {
    const cfg = billing[source];
    if (!cfg || cfg.kind === 'free') continue;
    if (cfg.kind === 'subscription') {
      subscription += money(cfg.monthly);
      continue;
    }
    if (cfg.kind === 'api') {
      const amount = apiAmount(source, buckets, cfg);
      if (amount == null) unpriced.push(source);
      else api += amount;
    }
  }

  return { subscription, api, unpriced };
}

export function costBreakdown(options: {
  buckets: TokenBucket[];
  billing: BillingConfig;
  includeChatgptInTotal: boolean;
  currency: Currency;
}): CostBreakdown {
  const codingBuckets = options.buckets.filter((bucket) => bucket.source !== CHATGPT_SOURCE);
  const chatgptBuckets = options.buckets.filter((bucket) => bucket.source === CHATGPT_SOURCE);
  const coding = costLine(codingBuckets, options.billing);
  const chatgpt = costLine(chatgptBuckets, options.billing);
  const total: CostLine = {
    subscription: coding.subscription + chatgpt.subscription,
    api: coding.api + (options.includeChatgptInTotal ? chatgpt.api : 0),
    unpriced: [
      ...coding.unpriced,
      ...(options.includeChatgptInTotal ? chatgpt.unpriced : []),
    ],
  };
  return { coding, chatgpt, total, currency: options.currency };
}

export function unpricedLabel(sources: string[]): string {
  if (sources.length === 0) return '';
  return sources.map(sourceLabel).join('、');
}
