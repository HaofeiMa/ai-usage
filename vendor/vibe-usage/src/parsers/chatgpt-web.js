import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { aggregateToBuckets, extractSessions } from './aggregate.js';

const SOURCE = 'chatgpt-web';
const PROJECT = 'chatgpt';

export function getChatgptWebLogPath(env = process.env) {
  const override = env.VIBE_USAGE_CHATGPT_WEB_LOG?.trim();
  if (override) return override;
  return join(homedir(), '.ai-usage', 'chatgpt-web.jsonl');
}

function toDate(createTime) {
  if (createTime == null || !Number.isFinite(Number(createTime))) return null;
  return new Date(Number(createTime) * 1000);
}

function dedupeKey(record) {
  const conversationId = record?.conversation_id;
  const messageId = record?.message_id;
  if (conversationId == null || messageId == null) return null;
  return `${conversationId}\0${messageId}`;
}

function sessionHashFromId(sessionId) {
  return createHash('sha256').update(String(sessionId)).digest('hex').slice(0, 16);
}

function modelFromRecord(record) {
  if (typeof record.model === 'string' && record.model.trim()) {
    return record.model.trim();
  }
  return 'unknown';
}

function processRecord(record, out) {
  const { entries, events, thinkingBySession } = out;
  const timestamp = toDate(record.create_time);
  const conversationId = record.conversation_id;
  const model = modelFromRecord(record);

  if (timestamp && record.isVisibleUser) {
    const inputTokens = Math.max(0, Number(record.estimated_tokens) || 0);
    if (inputTokens > 0) {
      entries.push({
        source: SOURCE,
        model,
        project: PROJECT,
        timestamp,
        inputTokens,
        outputTokens: 0,
        cachedInputTokens: 0,
        reasoningOutputTokens: 0,
      });
    }
    events.push({
      sessionId: conversationId,
      source: SOURCE,
      project: PROJECT,
      timestamp,
      role: 'user',
    });
  }

  if (timestamp && record.isVisibleAssistant) {
    const outputTokens = Math.max(0, Number(record.estimated_tokens) || 0);
    if (outputTokens > 0) {
      entries.push({
        source: SOURCE,
        model,
        project: PROJECT,
        timestamp,
        inputTokens: 0,
        outputTokens,
        cachedInputTokens: 0,
        reasoningOutputTokens: 0,
      });
    }
  }

  if (timestamp && record.isFinalReply) {
    events.push({
      sessionId: conversationId,
      source: SOURCE,
      project: PROJECT,
      timestamp,
      role: 'assistant',
    });
  }

  if (record.isModelStep && conversationId != null) {
    const thinking = Math.max(0, Number(record.thinking_seconds) || 0);
    if (thinking > 0) {
      thinkingBySession.set(
        conversationId,
        (thinkingBySession.get(conversationId) || 0) + thinking,
      );
    }
  }
}

export function recordsFromLog(text) {
  const byKey = new Map();

  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let record;
    try {
      record = JSON.parse(trimmed);
    } catch {
      continue;
    }

    const key = dedupeKey(record);
    if (!key) continue;
    byKey.set(key, record);
  }

  const entries = [];
  const events = [];
  const thinkingBySession = new Map();

  for (const record of byKey.values()) {
    processRecord(record, { entries, events, thinkingBySession });
  }

  return { entries, events, thinkingBySession };
}

function sessionsWithThinking(events, thinkingBySession) {
  const sessions = extractSessions(events);
  const thinkingByHash = new Map();
  for (const [conversationId, thinking] of thinkingBySession) {
    thinkingByHash.set(sessionHashFromId(conversationId), thinking);
  }

  for (const session of sessions) {
    session.activeSeconds = Math.round(thinkingByHash.get(session.sessionHash) || 0);
  }

  return sessions;
}

export async function parse() {
  const logPath = getChatgptWebLogPath();
  if (!existsSync(logPath)) {
    return { buckets: [], sessions: [], skipped: true };
  }

  let content;
  try {
    content = readFileSync(logPath, 'utf-8');
  } catch {
    return { buckets: [], sessions: [], skipped: true };
  }

  const { entries, events, thinkingBySession } = recordsFromLog(content);

  return {
    buckets: aggregateToBuckets(entries),
    sessions: sessionsWithThinking(events, thinkingBySession),
  };
}
