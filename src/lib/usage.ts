export type View = 'coding' | 'chatgpt' | 'all';

const CHATGPT_SOURCE = 'chatgpt-web';
export const CURSOR_CLOUD_HOSTNAME = 'cursor-cloud';

export function dropCloudRows<T extends { hostname?: string }>(items: T[]): T[] {
  return items.filter((item) => item.hostname !== CURSOR_CLOUD_HOSTNAME);
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function shouldIncludeSource(
  source: string,
  view: View,
  includeChatgptInTotal: boolean,
): boolean {
  const isChatgpt = source === CHATGPT_SOURCE;

  if (view === 'coding') return !isChatgpt;
  if (view === 'chatgpt') return isChatgpt;
  return includeChatgptInTotal || !isChatgpt;
}

function filterByView<T extends { source: string }>(
  items: T[],
  view: View,
  includeChatgptInTotal: boolean,
): T[] {
  return items.filter((item) =>
    shouldIncludeSource(item.source, view, includeChatgptInTotal),
  );
}

export function filterBuckets<T extends { source: string }>(
  buckets: T[],
  view: View,
  includeChatgptInTotal: boolean,
): T[] {
  return filterByView(buckets, view, includeChatgptInTotal);
}

export function filterSessions<T extends { source: string }>(
  sessions: T[],
  view: View,
  includeChatgptInTotal: boolean,
): T[] {
  return filterByView(sessions, view, includeChatgptInTotal);
}

export function computedTotal(
  b: Record<string, unknown>,
  includeCache = false,
): number {
  const base =
    num(b.inputTokens) + num(b.outputTokens) + num(b.reasoningOutputTokens);
  return includeCache ? base + num(b.cachedInputTokens) : base;
}

export function summaryCards(
  buckets: Record<string, unknown>[],
  sessions: Record<string, unknown>[],
  includeCache = false,
) {
  let totalTokens = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let cachedTokens = 0;

  for (const bucket of buckets) {
    totalTokens += computedTotal(bucket, includeCache);
    inputTokens += num(bucket.inputTokens);
    outputTokens += num(bucket.outputTokens) + num(bucket.reasoningOutputTokens);
    cachedTokens += num(bucket.cachedInputTokens);
  }

  let activeSeconds = 0;
  let durationSeconds = 0;
  let messageCount = 0;

  for (const session of sessions) {
    activeSeconds += num(session.activeSeconds);
    durationSeconds += num(session.durationSeconds);
    messageCount += num(session.messageCount);
  }

  return {
    totalTokens,
    inputTokens,
    outputTokens,
    cachedTokens,
    activeSeconds,
    durationSeconds,
    sessionCount: sessions.length,
    messageCount,
  };
}

export function trayTokens(
  buckets: Record<string, unknown>[],
  includeCache = false,
): number {
  let total = 0;

  for (const bucket of buckets) {
    total += computedTotal(bucket, includeCache);
  }

  return total;
}
