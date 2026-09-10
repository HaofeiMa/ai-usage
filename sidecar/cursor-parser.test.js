import { describe, expect, it } from 'vitest';
import { entriesFromDeviceLog, sessionsFromDeviceLog } from '../vendor/vibe-usage/src/parsers/cursor.js';

function stopLine(overrides = {}) {
  return JSON.stringify({
    v: 1,
    event: 'stop',
    ts: '2026-09-10T06:50:18.215Z',
    model: 'cursor-grok-4.6-xhigh',
    input_tokens: 12,
    output_tokens: 3,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    generation_id: 'gen-project',
    conversation_id: 'conv-1',
    project: 'ai-usage',
    ...overrides,
  });
}

describe('cursor device log parser', () => {
  it('keeps the recorded project name from the hook jsonl', () => {
    const entries = entriesFromDeviceLog(stopLine());
    expect(entries).toHaveLength(1);
    expect(entries[0].project).toBe('ai-usage');
  });

  it('turns stop events in one conversation into a session with duration', () => {
    const text = [
      stopLine({
        ts: '2026-09-10T02:00:00.000Z',
        generation_id: 'gen-a',
      }),
      stopLine({
        ts: '2026-09-10T02:05:00.000Z',
        generation_id: 'gen-b',
        input_tokens: 40,
        output_tokens: 8,
      }),
    ].join('\n');

    const sessions = sessionsFromDeviceLog(text);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].source).toBe('cursor');
    expect(sessions[0].project).toBe('ai-usage');
    expect(sessions[0].userMessageCount).toBe(1);
    expect(sessions[0].messageCount).toBe(3);
    expect(sessions[0].durationSeconds).toBe(301);
    expect(sessions[0].activeSeconds).toBe(300);
  });

  it('does not double-count a rewritten generation_id', () => {
    const text = [
      stopLine({ ts: '2026-09-10T02:00:00.000Z', generation_id: 'gen-a', output_tokens: 1 }),
      stopLine({ ts: '2026-09-10T02:00:02.000Z', generation_id: 'gen-a', output_tokens: 9 }),
    ].join('\n');

    const sessions = sessionsFromDeviceLog(text);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].messageCount).toBe(2);
  });
});
