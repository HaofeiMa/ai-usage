import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export function stripText(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return record;
  if (!Object.prototype.hasOwnProperty.call(record, 'text')) return record;
  const { text: _text, ...rest } = record;
  return rest;
}

export function resolveLogPath() {
  const override = process.env.AI_USAGE_CHATGPT_WEB_LOG || process.env.VIBE_USAGE_CHATGPT_WEB_LOG;
  if (override) return override;
  return path.join(os.homedir(), '.ai-usage', 'chatgpt-web.jsonl');
}

export function recordsFromMessage(message) {
  if (Array.isArray(message)) return message;
  if (message && typeof message === 'object' && Array.isArray(message.records)) return message.records;
  return null;
}

export function parseMessagesFromBuffer(buffer, endianness = os.endianness()) {
  const messages = [];
  let offset = 0;
  const readLength = endianness === 'LE'
    ? buf => buf.readUInt32LE(0)
    : buf => buf.readUInt32BE(0);

  while (offset + 4 <= buffer.length) {
    const length = readLength(buffer.subarray(offset, offset + 4));
    offset += 4;
    if (offset + length > buffer.length) {
      offset -= 4;
      break;
    }
    const jsonBytes = buffer.subarray(offset, offset + length);
    offset += length;
    try {
      messages.push(JSON.parse(jsonBytes.toString('utf8')));
    } catch {
      // Ignore malformed JSON frames.
    }
  }

  return { messages, remainder: buffer.subarray(offset) };
}

export async function appendRecords(records, logPath) {
  if (!Array.isArray(records) || records.length === 0) return;
  await fs.mkdir(path.dirname(logPath), { recursive: true });
  const lines = records.map(record => `${JSON.stringify(stripText(record))}\n`).join('');
  const handle = await fs.open(logPath, 'a');
  try {
    await handle.write(lines);
  } finally {
    await handle.close();
  }
}

async function runHost() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const buffer = Buffer.concat(chunks);
  const { messages } = parseMessagesFromBuffer(buffer);
  const logPath = resolveLogPath();

  for (const message of messages) {
    const records = recordsFromMessage(message);
    if (records) await appendRecords(records, logPath);
  }
}

const isMain = process.argv[1]
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isMain) {
  runHost().catch(err => {
    console.error(err);
    process.exit(1);
  });
}
