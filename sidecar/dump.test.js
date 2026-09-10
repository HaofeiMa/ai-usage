import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
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

    for (const key of [
      'HOME',
      'USERPROFILE',
      'AI_USAGE_HOME',
      'VIBE_USAGE_CONFIG_DIR',
      'VIBE_USAGE_STATE_DIR',
      'VIBE_USAGE_CACHE_DIR',
      'VIBE_USAGE_CHATGPT_WEB_LOG',
      'AI_USAGE_VIBE_USAGE_SRC',
      'VIBE_USAGE_CURSOR_MODE',
      'VIBE_USAGE_CURSOR_DEVICE_LOG',
    ]) {
      prev[key] = process.env[key];
    }
    process.env.HOME = tmpHome;
    process.env.USERPROFILE = tmpHome;
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

  it('stampHostname fills missing hostnames without overwriting existing ones', async () => {
    const { stampHostname } = await import('./dump.mjs');
    const rows = [
      { source: 'codex' },
      { source: 'cursor', hostname: 'already-set' },
      { source: 'chatgpt-web', hostname: '' },
    ];
    stampHostname(rows, 'mbp.local');
    expect(rows[0].hostname).toBe('mbp.local');
    expect(rows[1].hostname).toBe('already-set');
    expect(rows[2].hostname).toBe('mbp.local');
  });

  it('dropCloudRows removes cursor-cloud hostname rows', async () => {
    const { dropCloudRows } = await import('./dump.mjs');
    const rows = [
      { source: 'cursor', hostname: 'Huffies-Mac-mini' },
      { source: 'cursor', hostname: 'cursor-cloud' },
      { source: 'codex', hostname: 'Huffies-Mac-mini' },
    ];
    expect(dropCloudRows(rows)).toEqual([rows[0], rows[2]]);
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

  it('applyAiUsageEnv sets VIBE_USAGE_CACHE_DIR to home/cache', async () => {
    const { applyAiUsageEnv } = await import('./dump.mjs');
    applyAiUsageEnv(tmpHome);
    expect(process.env.VIBE_USAGE_CACHE_DIR).toBe(join(tmpHome, 'cache'));
    expect(process.env.VIBE_USAGE_CONFIG_DIR).toBe(tmpHome);
    expect(process.env.VIBE_USAGE_STATE_DIR).toBe(tmpHome);
    expect(process.env.VIBE_USAGE_CURSOR_MODE).toBe('device');
    expect(process.env.VIBE_USAGE_CURSOR_DEVICE_LOG).toBe(join(tmpHome, 'cursor-device.jsonl'));
  });

  it('dumpSnapshot drops leftover cursor-cloud rows when merging history', async () => {
    writeFileSync(
      join(tmpHome, 'snapshot.json'),
      JSON.stringify({
        buckets: [
          { source: 'cursor', hostname: 'cursor-cloud', inputTokens: 999 },
          { source: '__kept__', inputTokens: 7 },
        ],
        sessions: [{ source: 'cursor', hostname: 'cursor-cloud', durationSeconds: 9 }],
        syncedAt: '2020-01-01T00:00:00.000Z',
      }) + '\n',
    );

    const { dumpSnapshot } = await import('./dump.mjs');
    await dumpSnapshot();

    const snapshot = JSON.parse(readFileSync(join(tmpHome, 'snapshot.json'), 'utf8'));
    expect(snapshot.buckets.some((b) => b.hostname === 'cursor-cloud')).toBe(false);
    expect(snapshot.sessions.some((s) => s.hostname === 'cursor-cloud')).toBe(false);
    expect(snapshot.buckets.some((b) => b.source === '__kept__' && b.inputTokens === 7)).toBe(true);
  });

  it('mergeSnapshotBySource keeps skipped sources and replaces succeeded ones', async () => {
    const { mergeSnapshotBySource } = await import('./dump.mjs');
    const previous = {
      buckets: [
        { source: 'cursor', inputTokens: 10 },
        { source: 'chatgpt-web', inputTokens: 1 },
      ],
      sessions: [
        { source: 'cursor', durationSeconds: 60 },
        { source: 'chatgpt-web', durationSeconds: 5 },
      ],
      syncedAt: '2026-01-01T00:00:00.000Z',
    };
    const collected = {
      buckets: [{ source: 'chatgpt-web', inputTokens: 99 }],
      sessions: [{ source: 'chatgpt-web', durationSeconds: 9 }],
      succeededSources: ['chatgpt-web'],
      syncedAt: '2026-09-09T00:00:00.000Z',
    };
    const merged = mergeSnapshotBySource(previous, collected);
    expect(merged.syncedAt).toBe('2026-09-09T00:00:00.000Z');
    expect(merged.buckets).toEqual([
      { source: 'chatgpt-web', inputTokens: 99 },
      { source: 'cursor', inputTokens: 10 },
    ]);
    expect(merged.sessions).toEqual([
      { source: 'chatgpt-web', durationSeconds: 9 },
      { source: 'cursor', durationSeconds: 60 },
    ]);
  });

  it('mergeSnapshotBySource drops a succeeded source that emitted nothing', async () => {
    const { mergeSnapshotBySource } = await import('./dump.mjs');
    const previous = {
      buckets: [
        { source: 'cursor', inputTokens: 10 },
        { source: 'codex', inputTokens: 3 },
      ],
      sessions: [{ source: 'cursor', durationSeconds: 8 }],
      syncedAt: 'old',
    };
    const collected = {
      buckets: [{ source: 'codex', inputTokens: 4 }],
      sessions: [],
      succeededSources: ['cursor', 'codex'],
      syncedAt: 'new',
    };
    const merged = mergeSnapshotBySource(previous, collected);
    expect(merged.buckets).toEqual([{ source: 'codex', inputTokens: 4 }]);
    expect(merged.sessions).toEqual([]);
    expect(merged.syncedAt).toBe('new');
  });

  it('dumpSnapshot keeps history for sources that did not succeed this run', async () => {
    writeFileSync(
      join(tmpHome, 'snapshot.json'),
      JSON.stringify({
        buckets: [
          { source: '__kept__', inputTokens: 42 },
          { source: 'chatgpt-web', inputTokens: 999999 },
        ],
        sessions: [
          { source: '__kept__', durationSeconds: 12 },
          { source: 'chatgpt-web', durationSeconds: 999 },
        ],
        syncedAt: '2020-01-01T00:00:00.000Z',
      }) + '\n',
    );

    const { dumpSnapshot } = await import('./dump.mjs');
    await dumpSnapshot();

    const snapshot = JSON.parse(readFileSync(join(tmpHome, 'snapshot.json'), 'utf8'));
    const chatgptInput = snapshot.buckets
      .filter((b) => b.source === 'chatgpt-web')
      .reduce((sum, b) => sum + b.inputTokens, 0);
    expect(chatgptInput).toBe(40);
    expect(snapshot.buckets.some((b) => b.source === '__kept__' && b.inputTokens === 42)).toBe(true);
    expect(snapshot.sessions.some((s) => s.source === '__kept__' && s.durationSeconds === 12)).toBe(true);
    expect(snapshot.sessions.some((s) => s.source === 'chatgpt-web' && s.durationSeconds === 999)).toBe(
      false,
    );
  });

  it('dumpSnapshot with injectables uploads only changed buckets and merges other hosts', async () => {
    writeFileSync(
      join(tmpHome, 'config.json'),
      JSON.stringify({
        apiUrl: 'http://127.0.0.1:9',
        apiKey: 'secret',
        hostname: 'mbp',
      }) + '\n',
    );
    const posts = [];
    const { dumpSnapshot } = await import('./dump.mjs');
    const ingestImpl = async (_url, _key, buckets, sessions) => {
      posts.push({ buckets, sessions });
      return { ingested: buckets.length };
    };
    const pullImpl = async () => ({
      buckets: [
        {
          source: 'codex',
          hostname: 'linux',
          model: 'g',
          project: 'p',
          bucketStart: 't',
          inputTokens: 9,
        },
      ],
      sessions: [],
      until: '2026-09-10T05:00:00.000Z',
    });
    await dumpSnapshot({ ingestImpl, pullImpl });
    const snap = JSON.parse(readFileSync(join(tmpHome, 'snapshot.json'), 'utf8'));
    expect(snap.buckets.some((b) => b.hostname === 'linux' && b.inputTokens === 9)).toBe(true);
    expect(snap.cloud.ingested).toBe(true);
    expect(snap.cloud.pulled).toBe(true);
    const firstCount = posts[0].buckets.length;
    expect(firstCount).toBeGreaterThan(0);
    await dumpSnapshot({ ingestImpl, pullImpl });
    expect(posts[1].buckets.length).toBe(0);
  });

  it('dumpSnapshot keeps other hosts from remote.json when pullImpl throws', async () => {
    writeFileSync(
      join(tmpHome, 'config.json'),
      JSON.stringify({
        apiUrl: 'http://127.0.0.1:9',
        apiKey: 'secret',
        hostname: 'mbp',
      }) + '\n',
    );
    writeFileSync(
      join(tmpHome, 'remote.json'),
      JSON.stringify({
        buckets: [{ source: 'codex', hostname: 'linux', inputTokens: 9, bucketStart: 't' }],
        sessions: [],
        since: '2026-09-01T00:00:00.000Z',
      }) + '\n',
    );
    const { dumpSnapshot } = await import('./dump.mjs');
    const result = await dumpSnapshot({
      ingestImpl: async () => ({ ingested: 0 }),
      pullImpl: async () => {
        throw new Error('HTTP 500');
      },
    });
    const snap = JSON.parse(readFileSync(join(tmpHome, 'snapshot.json'), 'utf8'));
    expect(snap.buckets.some((b) => b.hostname === 'linux')).toBe(true);
    expect(snap.cloud.pulled).toBe(false);
    expect(snap.cloud.error).toMatch(/拉取失败/);
    expect(result.pulled).toBe(false);
  });

  it('resolveVibeUsageSrc prefers AI_USAGE_VIBE_USAGE_SRC', async () => {
    const { resolveVibeUsageSrc } = await import('./dump.mjs');
    expect(resolveVibeUsageSrc({ AI_USAGE_VIBE_USAGE_SRC: '/custom/src' }, '/unused')).toBe(
      '/custom/src',
    );
  });

  describe('host-aware merge', () => {
    it('keeps other hostnames from remote and uses local for this host', async () => {
      const { mergeLocalAndRemote } = await import('./merge.mjs');
      const local = {
        buckets: [{ source: 'codex', hostname: 'mbp', inputTokens: 3, bucketStart: 'a' }],
        sessions: [{ source: 'codex', sessionHash: 's-mbp', hostname: 'mbp' }],
      };
      const remote = {
        buckets: [
          { source: 'codex', hostname: 'mbp', inputTokens: 1, bucketStart: 'a' },
          { source: 'codex', hostname: 'linux', inputTokens: 9, bucketStart: 'a' },
          { source: 'cursor', hostname: 'cursor-cloud', inputTokens: 8, bucketStart: 'a' },
        ],
        sessions: [
          { source: 'codex', sessionHash: 's-linux', hostname: 'linux' },
          { source: 'codex', sessionHash: 's-mbp', hostname: 'mbp' },
        ],
      };
      const merged = mergeLocalAndRemote(local, remote, 'mbp');
      expect(merged.buckets).toEqual([
        { source: 'codex', hostname: 'linux', inputTokens: 9, bucketStart: 'a' },
        { source: 'codex', hostname: 'mbp', inputTokens: 3, bucketStart: 'a' },
      ]);
      expect(merged.sessions.map((s) => s.sessionHash).sort()).toEqual(['s-linux', 's-mbp']);
    });

    it('mergeSnapshotBySourceForHost does not drop other hostnames in previous', async () => {
      const { mergeSnapshotBySourceForHost } = await import('./merge.mjs');
      const previous = {
        buckets: [
          { source: 'chatgpt-web', hostname: 'linux', inputTokens: 50 },
          { source: 'chatgpt-web', hostname: 'mbp', inputTokens: 1 },
          { source: 'cursor', hostname: 'mbp', inputTokens: 7 },
        ],
        sessions: [],
      };
      const collected = {
        buckets: [{ source: 'chatgpt-web', hostname: 'mbp', inputTokens: 40 }],
        sessions: [],
        succeededSources: ['chatgpt-web'],
        syncedAt: 'new',
      };
      const local = mergeSnapshotBySourceForHost(previous, collected, 'mbp');
      expect(local.buckets).toEqual([
        { source: 'chatgpt-web', hostname: 'mbp', inputTokens: 40 },
        { source: 'cursor', hostname: 'mbp', inputTokens: 7 },
      ]);
    });

    it('upsertByIdentity last-write-wins without dropping untouched keys', async () => {
      const { upsertByIdentity, bucketIdentity } = await import('./merge.mjs');
      const prev = [
        { source: 'codex', model: 'g', project: 'p', hostname: 'linux', bucketStart: 't1', inputTokens: 1 },
        { source: 'codex', model: 'g', project: 'p', hostname: 'win', bucketStart: 't1', inputTokens: 2 },
      ];
      const incoming = [
        { source: 'codex', model: 'g', project: 'p', hostname: 'win', bucketStart: 't1', inputTokens: 5 },
      ];
      const out = upsertByIdentity(prev, incoming, bucketIdentity);
      expect(out.find((b) => b.hostname === 'win').inputTokens).toBe(5);
      expect(out.find((b) => b.hostname === 'linux').inputTokens).toBe(1);
    });
  });

  it('resolveVibeUsageSrc prefers vendored parsers then sibling checkouts', async () => {
    const { resolveVibeUsageSrc } = await import('./dump.mjs');
    const root = mkdtempSync(join(tmpdir(), 'ai-usage-vu-src-'));
    const repoRoot = join(root, 'ai-usage');
    mkdirSync(repoRoot);
    try {
      expect(resolveVibeUsageSrc({}, repoRoot)).toBe(join(repoRoot, 'vendor', 'vibe-usage', 'src'));

      mkdirSync(join(root, 'vibe-usage', 'src', 'parsers'), { recursive: true });
      writeFileSync(join(root, 'vibe-usage', 'src', 'parsers', 'index.js'), 'export {}\n');
      expect(resolveVibeUsageSrc({}, repoRoot)).toBe(join(root, 'vibe-usage', 'src'));

      mkdirSync(join(root, 'vibe-usage-chatgpt-web', 'src', 'parsers'), { recursive: true });
      writeFileSync(join(root, 'vibe-usage-chatgpt-web', 'src', 'parsers', 'index.js'), 'export {}\n');
      expect(resolveVibeUsageSrc({}, repoRoot)).toBe(join(root, 'vibe-usage-chatgpt-web', 'src'));

      mkdirSync(join(repoRoot, 'vendor', 'vibe-usage', 'src', 'parsers'), { recursive: true });
      writeFileSync(join(repoRoot, 'vendor', 'vibe-usage', 'src', 'parsers', 'index.js'), 'export {}\n');
      expect(resolveVibeUsageSrc({}, repoRoot)).toBe(join(repoRoot, 'vendor', 'vibe-usage', 'src'));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
