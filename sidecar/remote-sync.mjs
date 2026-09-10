import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import {
  bucketKey,
  bucketHash,
  sessionKey,
  sessionHash,
} from '../vendor/vibe-usage/src/state.js';
import { bucketIdentity, sessionIdentity, upsertByIdentity } from './merge.mjs';

export function changedBuckets(items, state) {
  const hashes = state?.buckets || {};
  return (items || []).filter((item) => hashes[bucketKey(item)] !== bucketHash(item));
}

export function changedSessions(items, state) {
  const hashes = state?.sessions || {};
  return (items || []).filter((item) => hashes[sessionKey(item)] !== sessionHash(item));
}

export function markUploaded(state, buckets, sessions) {
  const next = {
    buckets: { ...(state?.buckets || {}) },
    sessions: { ...(state?.sessions || {}) },
  };
  for (const item of buckets || []) next.buckets[bucketKey(item)] = bucketHash(item);
  for (const item of sessions || []) next.sessions[sessionKey(item)] = sessionHash(item);
  return next;
}

export function readRemoteCache(home) {
  try {
    const parsed = JSON.parse(readFileSync(join(home, 'remote.json'), 'utf8'));
    return {
      buckets: Array.isArray(parsed.buckets) ? parsed.buckets : [],
      sessions: Array.isArray(parsed.sessions) ? parsed.sessions : [],
      since: typeof parsed.since === 'string' ? parsed.since : null,
    };
  } catch {
    return { buckets: [], sessions: [], since: null };
  }
}

export function writeRemoteCache(home, cache) {
  mkdirSync(home, { recursive: true });
  const target = join(home, 'remote.json');
  const tempPath = `${target}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  const body = JSON.stringify({
    buckets: cache.buckets || [],
    sessions: cache.sessions || [],
    since: cache.since ?? null,
  }, null, 2) + '\n';
  try {
    writeFileSync(tempPath, body, 'utf8');
    renameSync(tempPath, target);
  } finally {
    rmSync(tempPath, { force: true });
  }
}

export function applyPull(cache, payload) {
  return {
    buckets: upsertByIdentity(cache?.buckets, payload?.buckets, bucketIdentity),
    sessions: upsertByIdentity(cache?.sessions, payload?.sessions, sessionIdentity),
    since: typeof payload?.until === 'string' ? payload.until : cache?.since ?? null,
  };
}

export function cloudStatus({ configured = false, ingested = false, pulled = false, error = null } = {}) {
  return { configured, ingested, pulled, error: error || null };
}
