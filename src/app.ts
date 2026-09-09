import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { enable, disable } from '@tauri-apps/plugin-autostart';
import { filterBuckets, filterSessions, summaryCards, type View } from './lib/usage.js';
import {
  filterBucketsByTime,
  filterSessionsByTime,
  timeRangeWindow,
  usesHourlyTrend,
  type TimeRangeId,
} from './lib/time-range.js';
import { filterByFacets, filterSessionsByFacets, uniqueValues } from './lib/facets.js';
import { distribution, tokenTrend } from './lib/charts.js';
import { formatCompactTokens, formatDuration } from './lib/format.js';

type Bucket = {
  source: string;
  hostname?: string;
  model?: string;
  project?: string;
  bucketStart: string | Date;
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  reasoningOutputTokens?: number;
};

type Session = {
  source: string;
  hostname?: string;
  model?: string;
  project?: string;
  firstMessageAt?: string | Date;
  lastMessageAt?: string | Date;
  activeSeconds?: number;
  durationSeconds?: number;
};

type Snapshot = {
  buckets: Bucket[];
  sessions: Session[];
  syncedAt?: string;
};

type DashboardState = {
  snapshot: Snapshot | null;
  config: {
    includeChatgptInTotal?: boolean;
    autostart?: boolean;
  };
  home: string;
  extensionPath: string;
  lastError: string | null;
  missingSnapshot: boolean;
};

const VIEWS: { id: View; label: string }[] = [
  { id: 'coding', label: '编程工具' },
  { id: 'chatgpt', label: 'ChatGPT' },
  { id: 'all', label: '全部' },
];

const RANGES: { id: TimeRangeId; label: string }[] = [
  { id: 'today', label: '今天' },
  { id: '24h', label: '24H' },
  { id: '7d', label: '7D' },
  { id: '30d', label: '30D' },
  { id: '90d', label: '90D' },
];

let remote: DashboardState | null = null;
let view: View = 'all';
let range: TimeRangeId = 'today';
let includeChatgpt = true;
let hostFilter = '';
let sourceFilter = '';
let modelFilter = '';
let projectFilter = '';
let settingsOpen = false;
let refreshing = false;
let autostartOn = true;

function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function optionList(values: string[], selected: string, allLabel = '全部'): string {
  return [`<option value="">${esc(allLabel)}</option>`]
    .concat(values.map((value) => `<option value="${esc(value)}" ${value === selected ? 'selected' : ''}>${esc(value)}</option>`))
    .join('');
}

function approxPrefix(show: boolean): string {
  return show ? '<span class="approx" title="ChatGPT 为估算">~</span>' : '';
}

function stackedBars(
  series: ReturnType<typeof tokenTrend>,
): string {
  if (series.length === 0) return '<div class="empty">暂无趋势数据</div>';
  const width = 1000;
  const height = 180;
  const pad = { l: 8, r: 8, t: 8, b: 28 };
  const innerW = width - pad.l - pad.r;
  const innerH = height - pad.t - pad.b;
  const max = Math.max(1, ...series.map((p) => p.totalTokens));
  const gap = 4;
  const barW = Math.max(4, innerW / series.length - gap);
  const showLabels = series.length <= 32;
  const bars = series
    .map((point, i) => {
      const x = pad.l + i * (innerW / series.length) + gap / 2;
      const codingH = (point.codingTokens / max) * innerH;
      const gptH = (point.chatgptTokens / max) * innerH;
      const yGpt = pad.t + innerH - gptH;
      const yCoding = yGpt - codingH;
      const label = showLabels
        ? `<text x="${x + barW / 2}" y="${height - 8}" text-anchor="middle" fill="#9aa8b5" font-size="10">${esc(point.label)}</text>`
        : '';
      return `<rect x="${x}" y="${yCoding}" width="${barW}" height="${codingH}" fill="#5b9fd6"></rect>
        <rect x="${x}" y="${yGpt}" width="${barW}" height="${gptH}" fill="#e0a24b"></rect>
        ${label}`;
    })
    .join('');
  return `<svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none">${bars}</svg>`;
}

function nativeMessagingHelp(): string {
  return `
      <p>扩展还需要 Native Messaging host（Chrome 要求 <code>path</code> 指向可执行脚本）：</p>
      <ol>
        <li>复制仓库里的 <code>native-host/com.aiusage.chatgpt.json</code> 到浏览器的 NativeMessagingHosts 目录</li>
        <li>把清单里的 <code>path</code> 改成 <code>native-host/host.mjs</code> 的绝对路径（脚本带 <code>#!/usr/bin/env node</code>，需可执行）</li>
        <li>把 <code>allowed_origins</code> 中的 <code>REPLACE_WITH_EXTENSION_ID</code> 换成扩展 ID（<code>chrome://extensions</code>）</li>
      </ol>
      <p>macOS Chrome：<code>~/Library/Application Support/Google/Chrome/NativeMessagingHosts/</code></p>
      <p>macOS Edge：<code>~/Library/Application Support/Microsoft Edge/NativeMessagingHosts/</code></p>
      <p>Linux Chrome：<code>~/.config/google-chrome/NativeMessagingHosts/</code></p>
  `;
}

function extensionInstallHelp(): string {
  return `
    <section class="settings">
      <h2>ChatGPT 网页扩展</h2>
      <p>尚未采集到 ChatGPT 网页用量。在 Chrome / Edge 中加载已解压的扩展：</p>
      <p><code>${esc(remote?.extensionPath ?? '')}</code></p>
      <ol>
        <li>打开 Chrome / Edge 的扩展页：<code>chrome://extensions</code> 或 <code>edge://extensions</code></li>
        <li>打开「开发者模式」</li>
        <li>选择「加载已解压的扩展程序」，指向上面的 <code>extension/</code> 目录</li>
        <li>打开并刷新 chatgpt.com，之后用量会写入本机 jsonl</li>
      </ol>
      ${nativeMessagingHelp()}
    </section>
  `;
}

function distList(rows: ReturnType<typeof distribution>, chatgptKeys = false): string {
  if (rows.length === 0) return '<div class="empty">暂无分布数据</div>';
  const top = rows.slice(0, 10);
  const rest = rows.slice(10).reduce((sum, row) => sum + row.tokens, 0);
  const shown = rest > 0 ? [...top, { key: '其他', tokens: rest }] : top;
  const max = Math.max(1, ...shown.map((row) => row.tokens));
  return shown
    .map((row) => {
      const isGpt = chatgptKeys && row.key === 'chatgpt-web';
      return `<div class="bar-row">
        <div title="${esc(row.key)}">${esc(row.key)}${isGpt ? ' ~' : ''}</div>
        <div class="bar-track"><div class="bar-fill${isGpt ? ' chatgpt' : ''}" style="width:${(row.tokens / max) * 100}%"></div></div>
        <div>${isGpt ? '~' : ''}${esc(formatCompactTokens(row.tokens))}</div>
      </div>`;
    })
    .join('');
}

function sliceData(snapshot: Snapshot) {
  const now = new Date();
  const window = timeRangeWindow(range, now);
  const viewBuckets = filterBuckets(snapshot.buckets, view, includeChatgpt);
  const viewSessions = filterSessions(snapshot.sessions, view, includeChatgpt);
  const timedBuckets = filterBucketsByTime(viewBuckets, window);
  const timedSessions = filterSessionsByTime(viewSessions, window);
  const facets = {
    hostnames: hostFilter ? [hostFilter] : [],
    sources: sourceFilter ? [sourceFilter] : [],
    models: modelFilter ? [modelFilter] : [],
    projects: projectFilter ? [projectFilter] : [],
  };
  return {
    optionBuckets: timedBuckets,
    buckets: filterByFacets(timedBuckets, facets),
    sessions: filterSessionsByFacets(timedSessions, facets),
  };
}

function render(root: HTMLElement) {
  const snapshot = remote?.snapshot ?? { buckets: [], sessions: [] };
  const missing = !remote || remote.missingSnapshot || !remote.snapshot;
  const hasChatgpt =
    (remote?.snapshot?.buckets ?? []).some((row) => row.source === 'chatgpt-web') ||
    (remote?.snapshot?.sessions ?? []).some((row) => row.source === 'chatgpt-web');
  const chatgptEmpty = view === 'chatgpt' && !hasChatgpt;
  const { optionBuckets, buckets, sessions } = sliceData(snapshot);
  const cards = summaryCards(buckets, sessions);
  const chatgptInPlay =
    view === 'chatgpt' ||
    (view === 'all' && includeChatgpt && buckets.some((b) => b.source === 'chatgpt-web'));
  const trend = tokenTrend(buckets, usesHourlyTrend(range) ? 'hour' : 'day');
  const hosts = uniqueValues(optionBuckets, 'hostname');
  const sources = uniqueValues(optionBuckets, 'source');
  const models = uniqueValues(optionBuckets, 'model');
  const projects = uniqueValues(optionBuckets, 'project');
  const syncedAt = remote?.snapshot?.syncedAt
    ? new Date(remote.snapshot.syncedAt).toLocaleString()
    : '尚未同步';

  root.innerHTML = `
    <div class="top">
      <div class="brand">AI Usage</div>
      <div class="seg tabs">
        ${VIEWS.map((item) => `<button data-view="${item.id}" class="${view === item.id ? 'active' : ''}">${item.label}</button>`).join('')}
      </div>
      <div class="seg ranges">
        ${RANGES.map((item) => `<button data-range="${item.id}" class="${range === item.id ? 'active' : ''}">${item.label}</button>`).join('')}
      </div>
      <label class="toggle">
        <input id="include-toggle" type="checkbox" ${includeChatgpt ? 'checked' : ''} />
        ChatGPT 估算计入总 Token
      </label>
    </div>
    <div class="filters">
      <label>终端 <select id="filter-host">${optionList(hosts, hostFilter)}</select></label>
      <label>工具 <select id="filter-source">${optionList(sources, sourceFilter)}</select></label>
      <label>模型 <select id="filter-model">${optionList(models, modelFilter)}</select></label>
      <label>项目 <select id="filter-project">${optionList(projects, projectFilter)}</select></label>
      <button id="toggle-settings">${settingsOpen ? '收起设置' : '设置'}</button>
    </div>
    <div class="content">
      ${missing ? `<div class="banner">暂无本地快照。请点击页脚「更新数据」采集本机用量（写入 ${esc(remote?.home ?? '~/.ai-usage')}）。</div>` : ''}
      ${chatgptEmpty ? `<div class="banner">ChatGPT 分段还没有数据。请按下面的步骤加载浏览器扩展。</div>` : ''}
      ${remote?.lastError ? `<div class="error">上次更新失败：${esc(remote.lastError)}</div>` : ''}
      <div class="cards">
        <div class="card"><div class="label">总 Token</div><div class="value">${approxPrefix(chatgptInPlay)}${esc(formatCompactTokens(cards.totalTokens))}</div></div>
        <div class="card"><div class="label">缓存 Token</div><div class="value">${esc(formatCompactTokens(cards.cachedTokens))}</div></div>
        <div class="card"><div class="label">活跃时长</div><div class="value">${esc(formatDuration(cards.activeSeconds))}</div></div>
        <div class="card"><div class="label">总时长</div><div class="value">${esc(formatDuration(cards.durationSeconds))}</div></div>
      </div>
      <div class="chart-card">
        <h2>Token 趋势</h2>
        <div class="legend">
          <span><i class="swatch coding"></i>编程工具</span>
          <span><i class="swatch chatgpt"></i>ChatGPT 估算</span>
        </div>
        <div class="trend">${stackedBars(trend)}</div>
      </div>
      <div class="dist-grid">
        <div><h2>按终端</h2>${distList(distribution(buckets, 'hostname'))}</div>
        <div><h2>按工具</h2>${distList(distribution(buckets, 'source'), true)}</div>
        <div><h2>按模型</h2>${distList(distribution(buckets, 'model'))}</div>
        <div><h2>按项目</h2>${distList(distribution(buckets, 'project'))}</div>
      </div>
      ${chatgptEmpty && !settingsOpen ? extensionInstallHelp() : ''}
      ${settingsOpen ? `
        <section class="settings">
          <h2>设置</h2>
          <p>数据目录：<code>${esc(remote?.home ?? '')}</code></p>
          <p>ChatGPT 扩展目录（加载已解压的扩展）：</p>
          <p><code>${esc(remote?.extensionPath ?? '')}</code></p>
          <ol>
            <li>打开 Chrome / Edge 的扩展页：<code>chrome://extensions</code> 或 <code>edge://extensions</code></li>
            <li>打开「开发者模式」</li>
            <li>选择「加载已解压的扩展程序」，指向上面的 <code>extension/</code> 目录</li>
            <li>打开并刷新 chatgpt.com，之后用量会写入本机 jsonl</li>
          </ol>
          ${nativeMessagingHelp()}
          <label class="toggle" style="margin:12px 0 0;margin-left:0">
            <input id="autostart-toggle" type="checkbox" ${autostartOn ? 'checked' : ''} />
            开机自动启动
          </label>
        </section>
      ` : ''}
    </div>
    <div class="footer">
      <span>上次同步：${esc(syncedAt)}</span>
      <span class="grow"></span>
      <button id="refresh-btn" ${refreshing ? 'disabled' : ''}>${refreshing ? '正在更新…' : '更新数据'}</button>
      <button id="quit-btn">退出</button>
    </div>
  `;

  bind(root);
}

function bind(root: HTMLElement) {
  root.querySelectorAll<HTMLButtonElement>('[data-view]').forEach((btn) => {
    btn.addEventListener('click', () => {
      view = btn.dataset.view as View;
      render(root);
    });
  });
  root.querySelectorAll<HTMLButtonElement>('[data-range]').forEach((btn) => {
    btn.addEventListener('click', () => {
      range = btn.dataset.range as TimeRangeId;
      render(root);
    });
  });
  root.querySelector('#include-toggle')?.addEventListener('change', async (event) => {
    includeChatgpt = (event.target as HTMLInputElement).checked;
    render(root);
    await persistConfig({ includeChatgptInTotal: includeChatgpt });
  });
  root.querySelector('#filter-host')?.addEventListener('change', (event) => {
    hostFilter = (event.target as HTMLSelectElement).value;
    render(root);
  });
  root.querySelector('#filter-source')?.addEventListener('change', (event) => {
    sourceFilter = (event.target as HTMLSelectElement).value;
    render(root);
  });
  root.querySelector('#filter-model')?.addEventListener('change', (event) => {
    modelFilter = (event.target as HTMLSelectElement).value;
    render(root);
  });
  root.querySelector('#filter-project')?.addEventListener('change', (event) => {
    projectFilter = (event.target as HTMLSelectElement).value;
    render(root);
  });
  root.querySelector('#toggle-settings')?.addEventListener('click', () => {
    settingsOpen = !settingsOpen;
    render(root);
  });
  root.querySelector('#autostart-toggle')?.addEventListener('change', async (event) => {
    autostartOn = (event.target as HTMLInputElement).checked;
    try {
      if (autostartOn) await enable();
      else await disable();
    } catch {
      // OS hook failed; still persist the user's intent.
    }
    await persistConfig({ autostart: autostartOn });
  });
  root.querySelector('#refresh-btn')?.addEventListener('click', () => void refresh());
  root.querySelector('#quit-btn')?.addEventListener('click', () => {
    void invoke('quit_command');
  });
}

async function persistConfig(patch: Record<string, unknown>) {
  try {
    remote = await invoke<DashboardState>('save_config', { patch });
    applyRemote();
  } catch (err) {
    if (remote) remote.lastError = String(err);
  }
  const root = document.querySelector<HTMLElement>('#app');
  if (root) render(root);
}

function applyRemote() {
  if (!remote) return;
  includeChatgpt = remote.config.includeChatgptInTotal !== false;
  if (typeof remote.config.autostart === 'boolean') autostartOn = remote.config.autostart;
}

async function load() {
  remote = await invoke<DashboardState>('get_state');
  applyRemote();
  if (remote.missingSnapshot) settingsOpen = true;
  const root = document.querySelector<HTMLElement>('#app');
  if (root) render(root);
}

async function refresh() {
  refreshing = true;
  const root = document.querySelector<HTMLElement>('#app');
  if (root) render(root);
  try {
    remote = await invoke<DashboardState>('refresh_data');
    applyRemote();
  } catch (err) {
    if (remote) remote.lastError = String(err);
    else remote = {
      snapshot: null,
      config: { includeChatgptInTotal: includeChatgpt },
      home: '',
      extensionPath: '',
      lastError: String(err),
      missingSnapshot: true,
    };
  } finally {
    refreshing = false;
    const next = document.querySelector<HTMLElement>('#app');
    if (root || next) render(next ?? root!);
  }
}

export async function startDashboard() {
  const root = document.querySelector<HTMLElement>('#app');
  if (!root) return;
  try {
    await load();
  } catch (err) {
    remote = {
      snapshot: null,
      config: { includeChatgptInTotal: true },
      home: '',
      extensionPath: '',
      lastError: String(err),
      missingSnapshot: true,
    };
    settingsOpen = true;
    render(root);
  }
  await listen('snapshot-updated', () => {
    void load();
  });
}
