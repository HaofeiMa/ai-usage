import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';

const ts = 1770000000;

function fixtureLine(overrides = {}) {
  return JSON.stringify({
    message_id: 'm1',
    conversation_id: 'c1',
    create_time: ts,
    role: 'user',
    isVisibleUser: false,
    isVisibleAssistant: false,
    isFinalReply: false,
    isModelStep: false,
    estimated_tokens: 0,
    ...overrides,
  });
}

function snapshotHasText(value) {
  if (value === null || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some(snapshotHasText);
  if ('text' in value) return true;
  return Object.values(value).some(snapshotHasText);
}

describe('sidecar dump', () => {
  let tmpHome;
  let logPath;
  const prev = {};

  beforeEach(() => {
    vi.resetModules();
    tmpHome = mkdtempSync(join(tmpdir(), 'ai-usage-dump-'));
    logPath = join(tmpHome, 'chatgpt-web.jsonl');
    writeFileSync(
      logPath,
      [
        fixtureLine({
          message_id: 'u1',
          isVisibleUser: true,
          estimated_tokens: 40,
          text: 'SECRET_USER',
          model: 'gpt-5',
        }),
        fixtureLine({
          message_id: 'a1',
          role: 'assistant',
          isVisibleUser: false,
          isVisibleAssistant: true,
          isFinalReply: true,
          estimated_tokens: 12,
          text: 'SECRET_ASSISTANT',
          create_time: ts + 60,
        }),
      ].join('\n') + '\n',
    );

    for (const key of ['HOME', 'AI_USAGE_HOME', 'VIBE_USAGE_CONFIG_DIR', 'VIBE_USAGE_STATE_DIR', 'VIBE_USAGE_CHATGPT_WEB_LOG']) {
      prev[key] = process.env[key];
    }
    process.env.HOME = tmpHome;
    process.env.AI_USAGE_HOME = tmpHome;
    process.env.VIBE_USAGE_CONFIG_DIR = tmpHome;
    process.env.VIBE_USAGE_STATE_DIR = tmpHome;
    process.env.VIBE_USAGE_CHATGPT_WEB_LOG = logPath;
  });

  afterEach(() => {
    for (const key of Object.keys(prev)) {
      if (prev[key] === undefined) delete process.env[key];
      else process.env[key] = prev[key];
    }
    if (tmpHome) rmSync(tmpHome, { recursive: true, force: true });
  });

  it('collectLocal returns chatgpt-web buckets and sessions without text', async () => {
    const { collectLocal } = await import('./dump.mjs');
    const { buckets, sessions, syncedAt } = await collectLocal();

    expect(syncedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(buckets.some((b) => b.source === 'chatgpt-web')).toBe(true);
    expect(sessions.some((s) => s.source === 'chatgpt-web')).toBe(true);
    expect(buckets.reduce((sum, b) => sum + b.inputTokens, 0)).toBe(40);
    expect(buckets.reduce((sum, b) => sum + b.outputTokens, 0)).toBe(12);
    expect(snapshotHasText({ buckets, sessions })).toBe(false);
  });

  it('dumpSnapshot writes ~/.ai-usage/snapshot.json without calling ingest when unconfigured', async () => {
    const { dumpSnapshot } = await import('./dump.mjs');
    const result = await dumpSnapshot();

    const snapshotPath = join(tmpHome, 'snapshot.json');
    expect(existsSync(snapshotPath)).toBe(true);
    expect(result.snapshotPath).toBe(snapshotPath);
    expect(result.ingested).toBe(false);

    const snapshot = JSON.parse(readFileSync(snapshotPath, 'utf8'));
    expect(snapshot.syncedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(snapshot.buckets.some((b) => b.source === 'chatgpt-web')).toBe(true);
    expect(snapshot.sessions.some((s) => s.source === 'chatgpt-web')).toBe(true);
    expect(snapshotHasText(snapshot)).toBe(false);
  });

  it('stampHostname fills missing hostnames and keeps sentinels', async () => {
    const { stampHostname } = await import('./dump.mjs');
    const rows = [
      { source: 'codex' },
      { source: 'cursor', hostname: 'cursor-cloud' },
      { source: 'chatgpt-web', hostname: '' },
    ];
    stampHostname(rows, 'mbp.local');
    expect(rows[0].hostname).toBe('mbp.local');
    expect(rows[1].hostname).toBe('cursor-cloud');
    expect(rows[2].hostname).toBe('mbp.local');
  });

  it('collectLocal stamps a stable hostname from config without overwriting sentinels', async () => {
    writeFileSync(join(tmpHome, 'config.json'), JSON.stringify({ hostname: 'test-host' }) + '\n');
    const { collectLocal } = await import('./dump.mjs');
    const { buckets, sessions } = await collectLocal();

    const chatgptBuckets = buckets.filter((b) => b.source === 'chatgpt-web');
    const chatgptSessions = sessions.filter((s) => s.source === 'chatgpt-web');
    expect(chatgptBuckets.length).toBeGreaterThan(0);
    expect(chatgptBuckets.every((b) => b.hostname === 'test-host')).toBe(true);
    expect(chatgptSessions.every((s) => s.hostname === 'test-host')).toBe(true);
  });

  it('resolveAiUsageHome defaults to ~/.ai-usage', async () => {
    const { resolveAiUsageHome } = await import('./dump.mjs');
    const prevHome = process.env.AI_USAGE_HOME;
    delete process.env.AI_USAGE_HOME;
    try {
      expect(resolveAiUsageHome()).toBe(join(homedir(), '.ai-usage'));
    } finally {
      if (prevHome === undefined) delete process.env.AI_USAGE_HOME;
      else process.env.AI_USAGE_HOME = prevHome;
    }
  });
});
