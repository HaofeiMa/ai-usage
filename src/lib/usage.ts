export type View = 'coding' | 'chatgpt' | 'all';

const CHATGPT_SOURCE = 'chatgpt-web';

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

export function computedTotal(b: Record<string, unknown>): number {
  return (
    num(b.inputTokens) + num(b.outputTokens) + num(b.reasoningOutputTokens)
  );
}

export function summaryCards(
  buckets: Record<string, unknown>[],
  sessions: Record<string, unknown>[],
) {
  let totalTokens = 0;
  let cachedTokens = 0;

  for (const bucket of buckets) {
    totalTokens += computedTotal(bucket);
    cachedTokens += num(bucket.cachedInputTokens);
  }

  let activeSeconds = 0;
  let durationSeconds = 0;

  for (const session of sessions) {
    activeSeconds += num(session.activeSeconds);
    durationSeconds += num(session.durationSeconds);
  }

  return {
    totalTokens,
    cachedTokens,
    activeSeconds,
    durationSeconds,
  };
}

export function trayTokens(buckets: Record<string, unknown>[]): number {
  let total = 0;

  for (const bucket of buckets) {
    total += computedTotal(bucket) + num(bucket.cachedInputTokens);
  }

  return total;
}
