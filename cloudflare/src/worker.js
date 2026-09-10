import { upsert, exportUsage, d1Adapter } from './store.js';

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

async function readBody(request) {
  const encoding = (request.headers.get('content-encoding') || '').toLowerCase();
  if (encoding.includes('gzip')) {
    const stream = request.body.pipeThrough(new DecompressionStream('gzip'));
    const text = await new Response(stream).text();
    return JSON.parse(text);
  }
  return request.json();
}

function authorized(request, env) {
  const token = env?.AUTH_TOKEN;
  if (!token) return false;
  return request.headers.get('authorization') === `Bearer ${token}`;
}

export async function handleRequest(request, env) {
  if (!authorized(request, env)) {
    return json({ error: 'UNAUTHORIZED' }, 401);
  }

  const store = env.store || d1Adapter(env.DB);
  const url = new URL(request.url);

  try {
    if (request.method === 'POST' && url.pathname === '/api/usage/ingest') {
      const body = await readBody(request);
      await upsert(store, body || {});
      return json({ ingested: (body.buckets || []).length });
    }

    if (request.method === 'GET' && url.pathname === '/api/usage') {
      const until = new Date().toISOString();
      const result = await exportUsage(store, {
        since: url.searchParams.get('since') || undefined,
        days: url.searchParams.get('days') || undefined,
        cursor: url.searchParams.get('cursor') || undefined,
        limit: url.searchParams.get('limit') || 2000,
        until,
      });
      return json({ ...result, until });
    }
  } catch (err) {
    const message = err?.message || String(err);
    return json({ error: message }, 500);
  }

  return json({ error: 'NOT_FOUND' }, 404);
}

export default {
  async fetch(request, env) {
    return handleRequest(request, env);
  },
};
