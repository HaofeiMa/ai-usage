import { describe, expect, it } from 'vitest';
import { projectKey, projectLabel, sourceLabel } from './labels.js';

describe('sourceLabel', () => {
  it('uses product display names for the main tools', () => {
    expect(sourceLabel('claude-code')).toBe('Claude Code');
    expect(sourceLabel('cursor')).toBe('Cursor');
    expect(sourceLabel('codex')).toBe('ChatGPT (Codex)');
    expect(sourceLabel('chatgpt-web')).toBe('ChatGPT 网页');
    expect(sourceLabel('copilot-cli')).toBe('GitHub Copilot CLI');
  });

  it('falls back to known tool names then the raw source id', () => {
    expect(sourceLabel('alma')).toBe('Alma');
    expect(sourceLabel('gemini-cli')).toBe('Gemini CLI');
    expect(sourceLabel('brand-new-tool')).toBe('brand-new-tool');
  });
});

describe('projectLabel', () => {
  it('keeps ChatGPT web project as the literal chatgpt', () => {
    expect(projectLabel('chatgpt')).toBe('chatgpt');
  });

  it('maps empty, missing, and unknown to 未命名', () => {
    expect(projectLabel('')).toBe('未命名');
    expect(projectLabel('unknown')).toBe('未命名');
    expect(projectLabel(undefined)).toBe('未命名');
    expect(projectLabel('  ')).toBe('未命名');
  });

  it('keeps real project names', () => {
    expect(projectLabel('ai-usage')).toBe('ai-usage');
  });
});

describe('projectKey', () => {
  it('collapses empty and unknown into one filter key', () => {
    expect(projectKey(undefined)).toBe('unknown');
    expect(projectKey('')).toBe('unknown');
    expect(projectKey('unknown')).toBe('unknown');
    expect(projectKey('ai-usage')).toBe('ai-usage');
  });
});
