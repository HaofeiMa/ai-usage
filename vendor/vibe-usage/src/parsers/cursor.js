import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { loadConfig } from '../config.js';
import { aggregateToBuckets, extractSessions } from './aggregate.js';
import { projectFromCwd } from './fs-utils.js';
import { queryDbJsonSnapshotOnLock, sqliteUnavailableError, isSqliteUnavailableError } from './sqlite.js';

export const CURSOR_CLOUD_HOSTNAME = 'cursor-cloud';
export const CURSOR_MODES = ['account', 'device'];

const STATE_DB_RELATIVE = join('User', 'globalStorage', 'state.vscdb');
const ACCESS_TOKEN_KEY = 'cursorAuth/accessToken';
const SESSION_COOKIE = 'WorkosCursorSessionToken';

function getDefaultStateDbPath() {
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'Cursor', STATE_DB_RELATIVE);
  }
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA?.trim() || join(homedir(), 'AppData', 'Roaming');
    return join(appData, 'Cursor', STATE_DB_RELATIVE);
  }
  const xdgConfigHome = process.env.XDG_CONFIG_HOME?.trim() || join(homedir(), '.config');
  return join(xdgConfigHome, 'Cursor', STATE_DB_RELATIVE);
}

export function getCursorStateDbPath() {
  const explicit = process.env.CURSOR_STATE_DB_PATH?.trim();
  if (explicit) {
    const resolved = resolve(explicit);
    return existsSync(resolved) ? resolved : null;
  }

  const configDirs = process.env.CURSOR_CONFIG_DIR?.trim();
  const candidates = configDirs
    ? configDirs.split(',').map(v => v.trim()).filter(Boolean).map(v => {
        const r = resolve(v);
        return r.endsWith('.vscdb') ? r : join(r, STATE_DB_RELATIVE);
      })
    : [getDefaultStateDbPath()];

  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
}

function readAccessToken(dbPath) {
  // Cursor app holds a write lock; queryDbJsonSnapshotOnLock copies the WAL set
  // to a temp dir and retries on "database is locked".
  const sql = `SELECT value FROM ItemTable WHERE key = '${ACCESS_TOKEN_KEY}' LIMIT 1`;
  const rows = queryDbJsonSnapshotOnLock(dbPath, sql, {
    tempPrefix: 'vibe-usage-cursor-',
    opts: { maxBuffer: 4 * 1024 * 1024, timeout: 15000 },
  });
  const value = rows[0]?.value;
  if (typeof value !== 'string') return null;
  const t = value.trim();
  return t || null;
}

function decodeJwtSub(token) {
  const payload = token.split('.')[1];
  if (!payload) return null;
  try {
    const b64 = payload.replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64.padEnd(Math.ceil(b64.length / 4) * 4, '=');
    const json = JSON.parse(Buffer.from(padded, 'base64').toString('utf-8'));
    return typeof json.sub === 'string' ? json.sub.trim() : null;
  } catch {
    return null;
  }
}

const FETCH_TIMEOUT_MS = 10_000;

async function fetchUsageCsv(token) {
  const url = `${(process.env.CURSOR_WEB_BASE_URL?.trim() || 'https://cursor.com').replace(/\/+$/, '')}/api/dashboard/export-usage-events-csv?strategy=tokens`;
  const sub = decodeJwtSub(token);
  // The dashboard API authenticates via the WorkosCursorSessionToken cookie in
  // `{sub}%3A%3A{jwt}` form (what the browser sends). Bearer and bare-token
  // cookies now return 401, so they're kept only as last-resort fallbacks.
  const userId = sub?.includes('|') ? sub.split('|').pop() : null;
  const cookieValues = [
    ...(sub ? [`${sub}%3A%3A${token}`] : []),
    ...(userId ? [`${userId}%3A%3A${token}`] : []),
    token,
  ];

  // Browser-mimicking headers, matching what the dashboard sends (and what
  // cursor-stats / cursor-price-tracking send) — Node's default UA is a
  // common target for intermittent WAF blocks on cursor.com.
  const baseHeaders = {
    Accept: 'text/csv,*/*;q=0.8',
    Origin: 'https://cursor.com',
    Referer: 'https://cursor.com/dashboard?tab=usage',
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
  };
  const attempts = cookieValues.map(cv => ({ Cookie: `${SESSION_COOKIE}=${cv}` }));
  attempts.push({ Authorization: `Bearer ${token}` });

  const failures = [];
  for (const headers of attempts) {
    let resp;
    try {
      resp = await fetch(url, {
        headers: { ...baseHeaders, ...headers },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
    } catch (e) {
      // Hard-fail on network/timeout: stop trying further headers (won't fix
      // a downed host) and signal a soft skip to the caller.
      const reason = e.name === 'TimeoutError' ? 'timeout' : `network: ${e.message}`;
      const err = new Error(`Cursor usage export skipped (${reason})`);
      err.skip = true;
      throw err;
    }
    if (resp.ok) return await resp.text();
    failures.push(`${resp.status} ${resp.statusText}`);
    // Only auth rejections are worth retrying with different credentials.
    // 429/5xx are transient server-side states — soft-skip like network errors
    // instead of surfacing them as auth failures every daemon cycle.
    if (resp.status !== 401 && resp.status !== 403) {
      const err = new Error(`Cursor usage export skipped (HTTP ${resp.status} ${resp.statusText})`);
      err.skip = true;
      throw err;
    }
  }
  // Every auth combo rejected — the stored token no longer works. Surface an
  // actionable message: re-signing in inside Cursor rewrites the token.
  throw new Error(`Cursor session rejected (${failures.join('; ')}). Open Cursor and sign in again (Cursor Settings → Account), then re-run sync.`);
}

function parseCsv(text) {
  const rows = [];
  let field = '';
  let row = [];
  let inQuotes = false;
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      field += c; i++; continue;
    }
    if (c === '"') { inQuotes = true; i++; continue; }
    if (c === ',') { row.push(field); field = ''; i++; continue; }
    if (c === '\r') { i++; continue; }
    if (c === '\n') { row.push(field); rows.push(row); field = ''; row = []; i++; continue; }
    field += c; i++;
  }
  if (field !== '' || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

function parseDate(value) {
  if (!value) return null;
  const t = String(value).trim();
  if (!t) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return new Date(`${t}T00:00:00Z`);
  const d = new Date(t);
  return isNaN(d.getTime()) ? null : d;
}

function parseInt0(value) {
  if (value == null) return 0;
  const n = Number(String(value).replace(/,/g, '').trim());
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

export function resolveCursorMode(env = process.env, config = null) {
  const fromEnv = env.VIBE_USAGE_CURSOR_MODE?.trim();
  if (fromEnv === 'account' || fromEnv === 'device') return fromEnv;
  const cfg = config ?? loadConfig();
  const fromCfg = cfg?.cursorMode;
  if (fromCfg === 'account' || fromCfg === 'device') return fromCfg;
  return 'account';
}

export function getCursorDeviceLogPath(env = process.env) {
  const explicit = env.VIBE_USAGE_CURSOR_DEVICE_LOG?.trim();
  if (explicit) return resolve(explicit);
  return join(homedir(), '.vibe-usage', 'cursor-device.jsonl');
}

export function entriesFromUsageCsv(text) {
  const rows = parseCsv(text);
  if (rows.length < 2) return [];

  const header = rows[0].map(h => h.trim());
  const idx = (name) => header.indexOf(name);
  const dateIdx = idx('Date');
  const modelIdx = idx('Model');
  const inputCacheWriteIdx = idx('Input (w/ Cache Write)');
  const inputNoCacheIdx = idx('Input (w/o Cache Write)');
  const cacheReadIdx = idx('Cache Read');
  const outputIdx = idx('Output Tokens');

  if (dateIdx < 0 || modelIdx < 0) return [];

  const entries = [];
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    if (row.length === 1 && row[0].trim() === '') continue;
    const timestamp = parseDate(row[dateIdx]);
    const model = row[modelIdx]?.trim();
    if (!timestamp || !model) continue;

    const inputCacheWrite = inputCacheWriteIdx >= 0 ? parseInt0(row[inputCacheWriteIdx]) : 0;
    const inputNoCache = inputNoCacheIdx >= 0 ? parseInt0(row[inputNoCacheIdx]) : 0;
    const cacheRead = cacheReadIdx >= 0 ? parseInt0(row[cacheReadIdx]) : 0;
    const output = outputIdx >= 0 ? parseInt0(row[outputIdx]) : 0;

    if (inputCacheWrite + inputNoCache + cacheRead + output === 0) continue;

    entries.push({
      source: 'cursor',
      model,
      project: 'unknown',
      // Cursor usage is pulled from the cloud API — it reflects the same account
      // data on every machine. Use a fixed sentinel so all machines share one row
      // per (model, bucket_start) rather than duplicating per hostname.
      hostname: CURSOR_CLOUD_HOSTNAME,
      timestamp,
      inputTokens: inputCacheWrite + inputNoCache,
      outputTokens: output,
      cachedInputTokens: cacheRead,
      reasoningOutputTokens: 0,
    });
  }
  return entries;
}

export function entriesFromDeviceLog(text) {
  const byId = new Map();
  const order = [];
  for (const line of String(text).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let rec;
    try { rec = JSON.parse(trimmed); } catch { continue; }
    if (!rec || rec.v !== 1) continue;
    const model = String(rec.model || '').trim();
    const timestamp = parseDate(rec.ts);
    if (!model || !timestamp) continue;

    const inputInclusive = parseInt0(rec.input_tokens);
    const cacheRead = parseInt0(rec.cache_read_tokens);
    const cacheWrite = parseInt0(rec.cache_write_tokens);
    const output = parseInt0(rec.output_tokens);
    const uncached = inputInclusive >= cacheRead + cacheWrite
      ? inputInclusive - cacheRead - cacheWrite
      : inputInclusive;
    const inputTokens = uncached + cacheWrite;
    if (inputTokens + cacheRead + output === 0) continue;

    const id = rec.generation_id || rec.subagent_id || `${rec.event || 'stop'}:${rec.ts}:${model}`;
    const entry = {
      source: 'cursor',
      model,
      project: projectFromCwd(typeof rec.project === 'string' ? rec.project : undefined),
      timestamp,
      inputTokens,
      outputTokens: output,
      cachedInputTokens: cacheRead,
      reasoningOutputTokens: 0,
    };
    if (!byId.has(id)) order.push(id);
    byId.set(id, entry);
  }
  return order.map(id => byId.get(id));
}

function deviceLogRecords(text) {
  const byId = new Map();
  const order = [];
  for (const line of String(text).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let rec;
    try { rec = JSON.parse(trimmed); } catch { continue; }
    if (!rec || rec.v !== 1) continue;
    const timestamp = parseDate(rec.ts);
    if (!timestamp) continue;
    const model = String(rec.model || '').trim();
    const id = rec.generation_id || rec.subagent_id || `${rec.event || 'stop'}:${rec.ts}:${model}`;
    if (!byId.has(id)) order.push(id);
    byId.set(id, { rec, timestamp, model });
  }
  return order.map(id => byId.get(id));
}

export function eventsFromDeviceLog(text) {
  const groups = new Map();
  for (const { rec, timestamp, model } of deviceLogRecords(text)) {
    const sessionId = String(rec.conversation_id || rec.generation_id || rec.subagent_id || '').trim()
      || `${rec.event || 'stop'}:${rec.ts}:${model}`;
    const role = rec.role === 'user' || rec.event === 'beforeSubmitPrompt' ? 'user' : 'assistant';
    const event = {
      sessionId,
      source: 'cursor',
      project: projectFromCwd(typeof rec.project === 'string' ? rec.project : undefined),
      timestamp,
      role,
    };
    if (!groups.has(sessionId)) groups.set(sessionId, []);
    groups.get(sessionId).push(event);
  }

  const events = [];
  for (const list of groups.values()) {
    list.sort((a, b) => a.timestamp - b.timestamp);
    if (!list.some((event) => event.role === 'user')) {
      const first = list[0];
      events.push({
        ...first,
        role: 'user',
        timestamp: new Date(first.timestamp.getTime() - 1000),
      });
    }
    events.push(...list);
  }
  return events;
}

export function sessionsFromDeviceLog(text) {
  return extractSessions(eventsFromDeviceLog(text));
}

function parseDeviceLog() {
  const logPath = getCursorDeviceLogPath();
  if (!existsSync(logPath)) {
    return {
      buckets: [],
      sessions: [],
      skipped: true,
      warnings: ['cursor device log missing; install the AI Usage Cursor hook and use Cursor on this machine'],
    };
  }
  let text;
  try {
    text = readFileSync(logPath, 'utf8');
  } catch (err) {
    const skip = new Error(`Cursor device log skipped (${err.message})`);
    skip.skip = true;
    throw skip;
  }
  return {
    buckets: aggregateToBuckets(entriesFromDeviceLog(text)),
    sessions: sessionsFromDeviceLog(text),
  };
}

export async function parse() {
  if (resolveCursorMode() === 'device') {
    try {
      return parseDeviceLog();
    } catch (err) {
      if (err && err.skip) return { buckets: [], sessions: [], skipped: true };
      throw err;
    }
  }

  const dbPath = getCursorStateDbPath();
  if (!dbPath) return { buckets: [], sessions: [] };

  let token;
  try {
    token = readAccessToken(dbPath);
  } catch (err) {
    if (isSqliteUnavailableError(err)) {
      throw sqliteUnavailableError('Cursor');
    }
    throw err;
  }
  if (!token) return { buckets: [], sessions: [] };

  let csv;
  try {
    csv = await fetchUsageCsv(token);
  } catch (err) {
    // Network/timeout → silent skip (avoid noisy daemon logs every 5 min).
    // Auth failure → bubble up so user sees they need to re-login in Cursor.
    // Tell sync.js this was not a successful empty snapshot so it preserves
    // Cursor's incremental state instead of pruning it as dead history.
    if (err && err.skip) return { buckets: [], sessions: [], skipped: true };
    throw err;
  }
  return { buckets: aggregateToBuckets(entriesFromUsageCsv(csv)), sessions: [] };
}
