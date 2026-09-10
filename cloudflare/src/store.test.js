import { describe, it, expect } from 'vitest';
import { gzipSync } from 'node:zlib';
import { handleRequest } from './worker.js';
import { memoryAdapter } from './store.js';

function env() {
  return { AUTH_TOKEN: 'secret', store: memoryAdapter() };
}

function authHeaders(extra = {}) {
  return { authorization: 'Bearer secret', ...extra };
}

describe('ai-usage worker', () => {
  it('rejects missing bearer', async () => {
    const res = await handleRequest(new Request('http://x/api/usage'), env());
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'UNAUTHORIZED' });
  });

  it('upserts chatgpt-web and returns it on GET', async () => {
    const e = env();
    const bucket = {
      source: 'chatgpt-web',
      model: 'gpt-5',
      project: 'chatgpt',
      hostname: 'mbp',
      bucketStart: '2026-09-10T00:00:00.000Z',
      inputTokens: 40,
      outputTokens: 12,
      cachedInputTokens: 0,
      reasoningOutputTokens: 0,
      totalTokens: 52,
    };
    const post = await handleRequest(
      new Request('http://x/api/usage/ingest', {
        method: 'POST',
        headers: { ...authHeaders(), 'content-type': 'application/json' },
        body: JSON.stringify({ buckets: [bucket], sessions: [] }),
      }),
      e,
    );
    expect(post.status).toBe(200);

    const again = {
      ...bucket,
      inputTokens: 99,
      totalTokens: 111,
    };
    await handleRequest(
      new Request('http://x/api/usage/ingest', {
        method: 'POST',
        headers: { ...authHeaders(), 'content-type': 'application/json' },
        body: JSON.stringify({ buckets: [again] }),
      }),
      e,
    );

    const get = await handleRequest(
      new Request('http://x/api/usage?days=90', { headers: authHeaders() }),
      e,
    );
    expect(get.status).toBe(200);
    const body = await get.json();
    expect(body.until).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(body.buckets).toHaveLength(1);
    expect(body.buckets[0].inputTokens).toBe(99);
    expect(body.buckets[0].source).toBe('chatgpt-web');
  });

  it('GET since skips older updated rows', async () => {
    const e = env();
    const oldBucket = {
      source: 'codex',
      model: 'g',
      project: 'p',
      hostname: 'linux',
      bucketStart: '2026-08-01T00:00:00.000Z',
      inputTokens: 1,
      outputTokens: 0,
      cachedInputTokens: 0,
      reasoningOutputTokens: 0,
      totalTokens: 1,
    };
    await handleRequest(
      new Request('http://x/api/usage/ingest', {
        method: 'POST',
        headers: { ...authHeaders(), 'content-type': 'application/json' },
        body: JSON.stringify({ buckets: [oldBucket] }),
      }),
      e,
    );
    const first = await handleRequest(
      new Request('http://x/api/usage?days=90', { headers: authHeaders() }),
      e,
    );
    const until = (await first.json()).until;
    await new Promise((resolve) => setTimeout(resolve, 15));

    const newer = {
      ...oldBucket,
      hostname: 'mbp',
      bucketStart: '2026-09-10T00:00:00.000Z',
      inputTokens: 8,
      totalTokens: 8,
    };
    await handleRequest(
      new Request('http://x/api/usage/ingest', {
        method: 'POST',
        headers: { ...authHeaders(), 'content-type': 'application/json' },
        body: JSON.stringify({ buckets: [newer] }),
      }),
      e,
    );

    const incremental = await handleRequest(
      new Request(`http://x/api/usage?since=${encodeURIComponent(until)}`, { headers: authHeaders() }),
      e,
    );
    const page = await incremental.json();
    expect(page.buckets).toEqual([
      expect.objectContaining({ hostname: 'mbp', inputTokens: 8 }),
    ]);
  });

  it('accepts gzip ingest bodies', async () => {
    const e = env();
    const bucket = {
      source: 'codex',
      model: 'g',
      project: 'p',
      hostname: 'win',
      bucketStart: '2026-09-10T00:00:00.000Z',
      inputTokens: 3,
      outputTokens: 0,
      cachedInputTokens: 0,
      reasoningOutputTokens: 0,
      totalTokens: 3,
    };
    const gz = gzipSync(Buffer.from(JSON.stringify({ buckets: [bucket] })));
    const post = await handleRequest(
      new Request('http://x/api/usage/ingest', {
        method: 'POST',
        headers: {
          ...authHeaders(),
          'content-type': 'application/json',
          'content-encoding': 'gzip',
        },
        body: gz,
      }),
      e,
    );
    expect(post.status).toBe(200);
    const get = await handleRequest(
      new Request('http://x/api/usage?days=90', { headers: authHeaders() }),
      e,
    );
    const body = await get.json();
    expect(body.buckets[0].hostname).toBe('win');
  });
});
