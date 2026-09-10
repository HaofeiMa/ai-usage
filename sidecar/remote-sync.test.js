import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  changedBuckets,
  changedSessions,
  markUploaded,
  applyPull,
  readRemoteCache,
  writeRemoteCache,
} from './remote-sync.mjs';

const bucket = {
  source: 'codex',
  model: 'g',
  project: 'p',
  hostname: 'mbp',
  bucketStart: '2026-09-10T00:00:00.000Z',
  inputTokens: 10,
  outputTokens: 0,
  cachedInputTokens: 0,
  reasoningOutputTokens: 0,
  totalTokens: 10,
};

describe('remote-sync', () => {
  it('changedBuckets skips items whose hash is already in state', () => {
    const state = { buckets: {}, sessions: {} };
    const first = changedBuckets([bucket], state);
    expect(first).toEqual([bucket]);
    const nextState = markUploaded(state, first, []);
    expect(changedBuckets([bucket], nextState)).toEqual([]);
    const updated = { ...bucket, inputTokens: 11, totalTokens: 11 };
    expect(changedBuckets([updated], nextState)).toEqual([updated]);
  });

  it('changedSessions skips unchanged session hashes', () => {
    const session = {
      source: 'codex',
      sessionHash: 'abc',
      hostname: 'mbp',
      project: 'p',
      firstMessageAt: '2026-09-10T00:00:00.000Z',
      lastMessageAt: '2026-09-10T00:01:00.000Z',
      durationSeconds: 60,
      activeSeconds: 10,
      messageCount: 2,
      userMessageCount: 1,
      userPromptHours: [],
    };
    const state = { buckets: {}, sessions: {} };
    expect(changedSessions([session], state)).toEqual([session]);
    const next = markUploaded(state, [], [session]);
    expect(changedSessions([session], next)).toEqual([]);
  });

  it('applyPull upserts incoming and keeps older host rows', () => {
    const cache = {
      buckets: [{ ...bucket, hostname: 'linux', inputTokens: 4 }],
      sessions: [],
      since: null,
    };
    const out = applyPull(cache, {
      buckets: [{ ...bucket, inputTokens: 10 }],
      sessions: [],
      until: '2026-09-10T04:00:00.000Z',
    });
    expect(out.since).toBe('2026-09-10T04:00:00.000Z');
    expect(out.buckets).toHaveLength(2);
    expect(out.buckets.find((b) => b.hostname === 'mbp').inputTokens).toBe(10);
  });

  it('readRemoteCache returns empty cache when file is missing', () => {
    const home = mkdtempSync(join(tmpdir(), 'ai-usage-remote-'));
    try {
      expect(readRemoteCache(home)).toEqual({ buckets: [], sessions: [], since: null });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('writeRemoteCache then readRemoteCache round-trips', () => {
    const home = mkdtempSync(join(tmpdir(), 'ai-usage-remote-'));
    try {
      writeRemoteCache(home, {
        buckets: [bucket],
        sessions: [],
        since: '2026-09-10T04:00:00.000Z',
      });
      const text = readFileSync(join(home, 'remote.json'), 'utf8');
      expect(JSON.parse(text).since).toBe('2026-09-10T04:00:00.000Z');
      expect(readRemoteCache(home).buckets).toHaveLength(1);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
