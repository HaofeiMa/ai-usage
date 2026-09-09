import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  stripText,
  resolveLogPath,
  parseMessagesFromBuffer,
  appendRecords,
  recordsFromMessage,
  processBufferChunk
} from './host.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function frameJson(value, endianness = os.endianness()) {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  const header = Buffer.alloc(4);
  if (endianness === 'LE') header.writeUInt32LE(body.length);
  else header.writeUInt32BE(body.length);
  return Buffer.concat([header, body]);
}

async function withTempLog(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-usage-host-'));
  const logPath = path.join(dir, 'chatgpt-web.jsonl');
  const prevAi = process.env.AI_USAGE_CHATGPT_WEB_LOG;
  const prevVibe = process.env.VIBE_USAGE_CHATGPT_WEB_LOG;
  process.env.AI_USAGE_CHATGPT_WEB_LOG = logPath;
  delete process.env.VIBE_USAGE_CHATGPT_WEB_LOG;
  try {
    await fn(logPath);
  } finally {
    if (prevAi === undefined) delete process.env.AI_USAGE_CHATGPT_WEB_LOG;
    else process.env.AI_USAGE_CHATGPT_WEB_LOG = prevAi;
    if (prevVibe === undefined) delete process.env.VIBE_USAGE_CHATGPT_WEB_LOG;
    else process.env.VIBE_USAGE_CHATGPT_WEB_LOG = prevVibe;
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test('stripText removes text field', () => {
  const out = stripText({ message_id: 'm1', text: 'secret', estimated_tokens: 3 });
  assert.deepEqual(out, { message_id: 'm1', estimated_tokens: 3 });
  assert.equal('text' in out, false);
});

test('stripText leaves records without text unchanged', () => {
  const input = { message_id: 'm1', role: 'user' };
  assert.deepEqual(stripText(input), input);
});

test('resolveLogPath defaults to ~/.ai-usage/chatgpt-web.jsonl', () => {
  const prevAi = process.env.AI_USAGE_CHATGPT_WEB_LOG;
  const prevVibe = process.env.VIBE_USAGE_CHATGPT_WEB_LOG;
  delete process.env.AI_USAGE_CHATGPT_WEB_LOG;
  delete process.env.VIBE_USAGE_CHATGPT_WEB_LOG;
  try {
    assert.equal(
      resolveLogPath(),
      path.join(os.homedir(), '.ai-usage', 'chatgpt-web.jsonl')
    );
  } finally {
    if (prevAi === undefined) delete process.env.AI_USAGE_CHATGPT_WEB_LOG;
    else process.env.AI_USAGE_CHATGPT_WEB_LOG = prevAi;
    if (prevVibe === undefined) delete process.env.VIBE_USAGE_CHATGPT_WEB_LOG;
    else process.env.VIBE_USAGE_CHATGPT_WEB_LOG = prevVibe;
  }
});

test('resolveLogPath prefers AI_USAGE_CHATGPT_WEB_LOG over VIBE_USAGE', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-usage-path-'));
  const aiPath = path.join(dir, 'ai.jsonl');
  const vibePath = path.join(dir, 'vibe.jsonl');
  const prevAi = process.env.AI_USAGE_CHATGPT_WEB_LOG;
  const prevVibe = process.env.VIBE_USAGE_CHATGPT_WEB_LOG;
  process.env.AI_USAGE_CHATGPT_WEB_LOG = aiPath;
  process.env.VIBE_USAGE_CHATGPT_WEB_LOG = vibePath;
  try {
    assert.equal(resolveLogPath(), aiPath);
    delete process.env.AI_USAGE_CHATGPT_WEB_LOG;
    assert.equal(resolveLogPath(), vibePath);
  } finally {
    if (prevAi === undefined) delete process.env.AI_USAGE_CHATGPT_WEB_LOG;
    else process.env.AI_USAGE_CHATGPT_WEB_LOG = prevAi;
    if (prevVibe === undefined) delete process.env.VIBE_USAGE_CHATGPT_WEB_LOG;
    else process.env.VIBE_USAGE_CHATGPT_WEB_LOG = prevVibe;
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('recordsFromMessage accepts array or { records }', () => {
  const rows = [{ message_id: 'a' }];
  assert.deepEqual(recordsFromMessage(rows), rows);
  assert.deepEqual(recordsFromMessage({ records: rows }), rows);
  assert.equal(recordsFromMessage({ bad: true }), null);
  assert.equal(recordsFromMessage('nope'), null);
});

test('parseMessagesFromBuffer decodes length-prefixed JSON in native endian', () => {
  const buffer = Buffer.concat([
    frameJson([{ message_id: 'm1' }]),
    frameJson({ records: [{ message_id: 'm2' }] })
  ]);
  const { messages, remainder } = parseMessagesFromBuffer(buffer);
  assert.equal(messages.length, 2);
  assert.deepEqual(messages[0], [{ message_id: 'm1' }]);
  assert.deepEqual(messages[1], { records: [{ message_id: 'm2' }] });
  assert.equal(remainder.length, 0);
});

test('parseMessagesFromBuffer skips malformed JSON without throwing', () => {
  const badBody = Buffer.from('{not json', 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(badBody.length);
  const good = frameJson([{ message_id: 'ok' }]);
  const { messages } = parseMessagesFromBuffer(Buffer.concat([header, badBody, good]));
  assert.equal(messages.length, 1);
  assert.deepEqual(messages[0], [{ message_id: 'ok' }]);
});

test('parseMessagesFromBuffer keeps incomplete trailing frame in remainder', () => {
  const full = frameJson([{ message_id: 'm1' }]);
  const partial = full.subarray(0, full.length - 2);
  const { messages, remainder } = parseMessagesFromBuffer(partial);
  assert.equal(messages.length, 0);
  assert.equal(remainder.length, partial.length);
});

test('appendRecords creates parent dir, strips text, and appends jsonl', async () => {
  await withTempLog(async logPath => {
    await appendRecords([
      { message_id: 'm1', conversation_id: 'c1', text: 'drop me', estimated_tokens: 4 },
      { message_id: 'm2', conversation_id: 'c1', estimated_tokens: 2 }
    ], logPath);

    const lines = (await fs.readFile(logPath, 'utf8')).trim().split('\n');
    assert.equal(lines.length, 2);
    const first = JSON.parse(lines[0]);
    const second = JSON.parse(lines[1]);
    assert.equal('text' in first, false);
    assert.equal(first.estimated_tokens, 4);
    assert.equal(second.message_id, 'm2');

    await appendRecords([{ message_id: 'm3', conversation_id: 'c1' }], logPath);
    const all = (await fs.readFile(logPath, 'utf8')).trim().split('\n');
    assert.equal(all.length, 3);
    assert.equal(JSON.parse(all[2]).message_id, 'm3');
  });
});

test('appendRecords uses append mode without truncating existing file', async () => {
  await withTempLog(async logPath => {
    await fs.mkdir(path.dirname(logPath), { recursive: true });
    await fs.writeFile(logPath, '{"message_id":"existing"}\n', 'utf8');
    await appendRecords([{ message_id: 'new' }], logPath);
    const lines = (await fs.readFile(logPath, 'utf8')).trim().split('\n');
    assert.equal(lines.length, 2);
    assert.equal(JSON.parse(lines[0]).message_id, 'existing');
    assert.equal(JSON.parse(lines[1]).message_id, 'new');
  });
});

test('processBufferChunk appends a complete frame without waiting for more input', async () => {
  await withTempLog(async logPath => {
    const frame = frameJson([{ message_id: 'instant' }]);
    const remainder = await processBufferChunk(Buffer.alloc(0), frame, logPath);
    assert.equal(remainder.length, 0);
    const lines = (await fs.readFile(logPath, 'utf8')).trim().split('\n');
    assert.equal(lines.length, 1);
    assert.equal(JSON.parse(lines[0]).message_id, 'instant');
  });
});

test('processBufferChunk holds a trailing partial frame until more bytes arrive', async () => {
  await withTempLog(async logPath => {
    const frame = frameJson([{ message_id: 'split' }]);
    const splitAt = Math.floor(frame.length / 2);
    const part1 = frame.subarray(0, splitAt);
    const part2 = frame.subarray(splitAt);

    let leftover = await processBufferChunk(Buffer.alloc(0), part1, logPath);
    assert.equal(leftover.length, part1.length);
    await assert.rejects(() => fs.readFile(logPath, 'utf8'), /ENOENT/);

    leftover = await processBufferChunk(leftover, part2, logPath);
    assert.equal(leftover.length, 0);
    const lines = (await fs.readFile(logPath, 'utf8')).trim().split('\n');
    assert.equal(lines.length, 1);
    assert.equal(JSON.parse(lines[0]).message_id, 'split');
  });
});

test('processBufferChunk appends first complete frame while holding incomplete second', async () => {
  await withTempLog(async logPath => {
    const frame1 = frameJson([{ message_id: 'first' }]);
    const frame2 = frameJson([{ message_id: 'second' }]);
    const partial2 = frame2.subarray(0, frame2.length - 3);
    const combined = Buffer.concat([frame1, partial2]);

    const leftover = await processBufferChunk(Buffer.alloc(0), combined, logPath);
    assert.equal(leftover.length, partial2.length);

    const lines = (await fs.readFile(logPath, 'utf8')).trim().split('\n');
    assert.equal(lines.length, 1);
    assert.equal(JSON.parse(lines[0]).message_id, 'first');
  });
});

test('host template manifest exists with placeholder origin', async () => {
  const manifestPath = path.join(__dirname, 'com.aiusage.chatgpt.json');
  const raw = await fs.readFile(manifestPath, 'utf8');
  const manifest = JSON.parse(raw);
  assert.equal(manifest.name, 'com.aiusage.chatgpt');
  assert.equal(manifest.type, 'stdio');
  assert.equal(manifest.path, 'HOST_PATH');
  assert.ok(manifest.allowed_origins.includes('chrome-extension://REPLACE_WITH_EXTENSION_ID/'));
});
