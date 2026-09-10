export const SOURCE_NAMES: Record<string, string> = {
  alma: 'Alma',
  'claude-code': 'Claude Code',
  codex: 'ChatGPT (Codex)',
  'chatgpt-web': 'ChatGPT 网页',
  grok: 'Grok',
  'copilot-cli': 'GitHub Copilot CLI',
  'craft-agent': 'CraftAgent',
  cursor: 'Cursor',
  dimagent: 'DimAgent',
  'gemini-cli': 'Gemini CLI',
  opencode: 'OpenCode',
  openclaw: 'OpenClaw',
  omp: 'Oh My Pi',
  'pi-coding-agent': 'pi',
  'qwen-code': 'Qwen Code',
  'kimi-code': 'Kimi Code',
  mimocode: 'MiMoCode',
  amp: 'Amp',
  droid: 'Droid',
  dsh: 'DeepSeek Harness',
  antigravity: 'Antigravity',
  'trae-cli': 'Trae CLI',
  hermes: 'Hermes',
  kiro: 'Kiro',
  cline: 'Cline',
  'roo-code': 'Roo Code',
  workbuddy: 'WorkBuddy',
  zcode: 'ZCode',
};

export const BILLING_SOURCES = Object.keys(SOURCE_NAMES);

export function sourceLabel(source: string): string {
  return SOURCE_NAMES[source] ?? source;
}

export function projectKey(value: string | undefined): string {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (!trimmed || trimmed === 'unknown') return 'unknown';
  return trimmed;
}

export function projectLabel(value: string | undefined): string {
  const key = projectKey(value);
  if (key === 'unknown') return '未命名';
  return key;
}
