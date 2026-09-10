export function bucketPk(row) {
  return `${row.source}|${row.model}|${row.project}|${row.hostname}|${row.bucketStart}`;
}

export function sessionPk(row) {
  return `${row.source}|${row.sessionHash}|${row.hostname || ''}`;
}

function toBucketRow(row, updatedAt) {
  return {
    source: String(row.source || ''),
    model: String(row.model ?? ''),
    project: String(row.project ?? ''),
    hostname: String(row.hostname || ''),
    bucketStart: row.bucketStart,
    inputTokens: Number(row.inputTokens) || 0,
    outputTokens: Number(row.outputTokens) || 0,
    cachedInputTokens: Number(row.cachedInputTokens) || 0,
    reasoningOutputTokens: Number(row.reasoningOutputTokens) || 0,
    totalTokens: Number(row.totalTokens) || 0,
    updatedAt,
  };
}

function toSessionRow(row, updatedAt) {
  return {
    source: String(row.source || ''),
    sessionHash: String(row.sessionHash || ''),
    hostname: String(row.hostname || ''),
    project: row.project,
    firstMessageAt: row.firstMessageAt,
    lastMessageAt: row.lastMessageAt,
    durationSeconds: Number(row.durationSeconds) || 0,
    activeSeconds: Number(row.activeSeconds) || 0,
    messageCount: Number(row.messageCount) || 0,
    userMessageCount: Number(row.userMessageCount) || 0,
    userPromptHours: row.userPromptHours,
    updatedAt,
  };
}

function compareUpdated(a, b) {
  const at = a.updatedAt || '';
  const bt = b.updatedAt || '';
  if (at < bt) return -1;
  if (at > bt) return 1;
  const ak = a._pk || '';
  const bk = b._pk || '';
  if (ak < bk) return -1;
  if (ak > bk) return 1;
  return 0;
}

function pageRows(rows, { since, days, cursor, limit, until }) {
  let filtered = rows;
  if (since) {
    filtered = filtered.filter((row) => row.updatedAt > since);
  } else {
    const dayCount = Number(days) > 0 ? Number(days) : 90;
    const cutoff = new Date(Date.parse(until) - dayCount * 24 * 60 * 60 * 1000).toISOString();
    filtered = filtered.filter((row) => {
      const start = row.bucketStart || row.firstMessageAt || row.updatedAt;
      return start >= cutoff;
    });
  }
  filtered = [...filtered].sort(compareUpdated);
  if (cursor) {
    const idx = filtered.findIndex((row) => `${row.updatedAt}|${row._pk}` === cursor);
    if (idx >= 0) filtered = filtered.slice(idx + 1);
  }
  const page = filtered.slice(0, limit);
  const last = page[page.length - 1];
  const nextCursor = filtered.length > limit ? `${last.updatedAt}|${last._pk}` : undefined;
  return { rows: page.map(({ _pk, ...row }) => row), cursor: nextCursor };
}

export function memoryAdapter() {
  const buckets = new Map();
  const sessions = new Map();
  return {
    async putBucket(row) {
      const stored = { ...row, _pk: bucketPk(row) };
      buckets.set(stored._pk, stored);
    },
    async putSession(row) {
      const stored = { ...row, _pk: sessionPk(row) };
      sessions.set(stored._pk, stored);
    },
    async listBuckets(query) {
      return pageRows([...buckets.values()], query);
    },
    async listSessions(query) {
      return pageRows([...sessions.values()], query);
    },
  };
}

export async function upsert(store, body) {
  const updatedAt = new Date().toISOString();
  for (const row of body.buckets || []) {
    await store.putBucket(toBucketRow(row, updatedAt));
  }
  for (const row of body.sessions || []) {
    await store.putSession(toSessionRow(row, updatedAt));
  }
}

export async function exportUsage(store, query) {
  const limit = Number(query.limit) > 0 ? Number(query.limit) : 2000;
  const opts = { ...query, limit };
  const bucketsPage = await store.listBuckets(opts);
  const sessionsPage = await store.listSessions(opts);
  const cursor = bucketsPage.cursor || sessionsPage.cursor;
  return {
    buckets: bucketsPage.rows,
    sessions: sessionsPage.rows,
    ...(cursor ? { cursor } : {}),
  };
}

function bindAll(stmt, values) {
  return stmt.bind(...values);
}

export function d1Adapter(db) {
  return {
    async putBucket(row) {
      const stmt = db.prepare(
        `INSERT INTO buckets (
          source, model, project, hostname, bucket_start,
          input_tokens, output_tokens, cached_input_tokens, reasoning_output_tokens, total_tokens, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(source, model, project, hostname, bucket_start) DO UPDATE SET
          input_tokens = excluded.input_tokens,
          output_tokens = excluded.output_tokens,
          cached_input_tokens = excluded.cached_input_tokens,
          reasoning_output_tokens = excluded.reasoning_output_tokens,
          total_tokens = excluded.total_tokens,
          updated_at = excluded.updated_at`,
      );
      await bindAll(stmt, [
        row.source,
        row.model,
        row.project,
        row.hostname,
        row.bucketStart,
        row.inputTokens,
        row.outputTokens,
        row.cachedInputTokens,
        row.reasoningOutputTokens,
        row.totalTokens,
        row.updatedAt,
      ]).run();
    },
    async putSession(row) {
      const stmt = db.prepare(
        `INSERT INTO sessions (
          source, session_hash, hostname, project, first_message_at, last_message_at,
          duration_seconds, active_seconds, message_count, user_message_count, user_prompt_hours, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(source, session_hash, hostname) DO UPDATE SET
          project = excluded.project,
          first_message_at = excluded.first_message_at,
          last_message_at = excluded.last_message_at,
          duration_seconds = excluded.duration_seconds,
          active_seconds = excluded.active_seconds,
          message_count = excluded.message_count,
          user_message_count = excluded.user_message_count,
          user_prompt_hours = excluded.user_prompt_hours,
          updated_at = excluded.updated_at`,
      );
      await bindAll(stmt, [
        row.source,
        row.sessionHash,
        row.hostname,
        row.project ?? null,
        row.firstMessageAt ?? null,
        row.lastMessageAt ?? null,
        row.durationSeconds,
        row.activeSeconds,
        row.messageCount,
        row.userMessageCount,
        row.userPromptHours == null ? null : JSON.stringify(row.userPromptHours),
        row.updatedAt,
      ]).run();
    },
    async listBuckets(query) {
      const { sql, values } = listSql('buckets', 'bucket_start', query);
      const result = await db.prepare(sql).bind(...values).all();
      const rows = (result.results || []).map(fromBucketD1);
      return paginateSqlRows(rows, query.limit);
    },
    async listSessions(query) {
      const { sql, values } = listSql('sessions', 'first_message_at', query);
      const result = await db.prepare(sql).bind(...values).all();
      const rows = (result.results || []).map(fromSessionD1);
      return paginateSqlRows(rows, query.limit);
    },
  };
}

function listSql(table, startCol, query) {
  const limit = Number(query.limit) > 0 ? Number(query.limit) : 2000;
  if (query.since) {
    return {
      sql: `SELECT * FROM ${table} WHERE updated_at > ? ORDER BY updated_at, source LIMIT ?`,
      values: [query.since, limit + 1],
    };
  }
  const dayCount = Number(query.days) > 0 ? Number(query.days) : 90;
  const cutoff = new Date(Date.parse(query.until) - dayCount * 24 * 60 * 60 * 1000).toISOString();
  return {
    sql: `SELECT * FROM ${table} WHERE COALESCE(${startCol}, updated_at) >= ? ORDER BY updated_at, source LIMIT ?`,
    values: [cutoff, limit + 1],
  };
}

function paginateSqlRows(rows, limit) {
  const cap = Number(limit) > 0 ? Number(limit) : 2000;
  const cursor = rows.length > cap ? `${rows[cap - 1].updatedAt}|${rows[cap - 1].source}` : undefined;
  return { rows: rows.slice(0, cap), cursor };
}

function fromBucketD1(row) {
  return {
    source: row.source,
    model: row.model,
    project: row.project,
    hostname: row.hostname,
    bucketStart: row.bucket_start,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    cachedInputTokens: row.cached_input_tokens,
    reasoningOutputTokens: row.reasoning_output_tokens,
    totalTokens: row.total_tokens,
    updatedAt: row.updated_at,
  };
}

function fromSessionD1(row) {
  let userPromptHours = row.user_prompt_hours;
  if (typeof userPromptHours === 'string') {
    try {
      userPromptHours = JSON.parse(userPromptHours);
    } catch {
      userPromptHours = undefined;
    }
  }
  return {
    source: row.source,
    sessionHash: row.session_hash,
    hostname: row.hostname,
    project: row.project,
    firstMessageAt: row.first_message_at,
    lastMessageAt: row.last_message_at,
    durationSeconds: row.duration_seconds,
    activeSeconds: row.active_seconds,
    messageCount: row.message_count,
    userMessageCount: row.user_message_count,
    userPromptHours,
    updatedAt: row.updated_at,
  };
}
