import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { enable, disable } from '@tauri-apps/plugin-autostart';
import { dropCloudRows, filterBuckets, filterSessions, summaryCards, type View } from './lib/usage.js';
import {
  filterBucketsByTime,
  filterSessionsByTime,
  timeRangeWindow,
  trendFillWindow,
  usesHourlyTrend,
  type TimeRangeId,
} from './lib/time-range.js';
import { filterByFacets, filterSessionsByFacets, uniqueProjects, uniqueValues } from './lib/facets.js';
import { distribution, tokenTrend } from './lib/charts.js';
import { formatCompactTokens, formatDuration } from './lib/format.js';
import { BILLING_SOURCES, projectLabel, sourceLabel } from './lib/labels.js';
import {
  costBreakdown,
  formatMoney,
  unpricedLabel,
  type BillingConfig,
  type CostLine,
  type Currency,
  type SourceBilling,
} from './lib/billing.js';
import { applyTheme, type ThemePref } from './lib/theme.js';
import { bindPickers, closeAllPickers, pickerMarkup, withAllOption } from './lib/picker.js';
import { cloudSyncLabel } from './lib/sync-status.js';
import {
  GITHUB_RELEASES_URL,
  GITHUB_URL,
  parseGithubRelease,
  updateStatus,
} from './lib/updates.js';
import logo from './assets/logo.png';

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
  messageCount?: number;
};

type Snapshot = {
  buckets: Bucket[];
  sessions: Session[];
  syncedAt?: string;
  cloud?: {
    configured?: boolean;
    ingested?: boolean;
    pulled?: boolean;
    error?: string | null;
  };
};

type AppConfig = {
  includeChatgptInTotal?: boolean;
  includeCacheInTotal?: boolean;
  autostart?: boolean;
  theme?: ThemePref;
  currency?: Currency;
  billing?: BillingConfig;
  apiUrl?: string;
  apiKey?: string;
  hostname?: string;
};

type DashboardState = {
  snapshot: Snapshot | null;
  config: AppConfig;
  home: string;
  extensionPath: string;
  lastError: string | null;
  missingSnapshot: boolean;
  chatgptExtensionReady?: boolean;
  cursorDeviceReady?: boolean;
  appVersion?: string;
  defaultHostname?: string;
};

const VIEWS: { id: View; label: string }[] = [
  { id: 'all', label: '全部' },
  { id: 'coding', label: '编程' },
  { id: 'chatgpt', label: '对话' },
];

const RANGES: { id: TimeRangeId; label: string }[] = [
  { id: 'today', label: '今天' },
  { id: '24h', label: '24H' },
  { id: '7d', label: '7D' },
  { id: '30d', label: '30D' },
  { id: '90d', label: '90D' },
  { id: 'all', label: '全部' },
];

const FEATURED_SOURCES = ['claude-code', 'cursor', 'codex', 'chatgpt-web'];

let remote: DashboardState | null = null;
let view: View = 'all';
let range: TimeRangeId = 'today';
let includeChatgpt = true;
let includeCache = false;
let themePref: ThemePref = 'system';
let currency: Currency = 'USD';
let billing: BillingConfig = {};
let hostFilter = '';
let sourceFilter = '';
let modelFilter = '';
let projectFilter = '';
type SettingsTab = 'general' | 'advanced' | 'about';
type UpdateCheck = {
  status: 'idle' | 'checking' | 'current' | 'available' | 'error';
  latest?: string;
  notes?: string;
  url?: string;
  error?: string;
};

let page: 'dashboard' | 'settings' = 'dashboard';
let settingsTab: SettingsTab = 'general';
let updateCheck: UpdateCheck = { status: 'idle' };
let refreshing = false;
let autostartOn = true;

const SETTINGS_TABS: { id: SettingsTab; label: string }[] = [
  { id: 'general', label: '通用' },
  { id: 'advanced', label: '高级' },
  { id: 'about', label: '关于' },
];

const THEME_PILLS: { id: ThemePref; label: string }[] = [
  { id: 'light', label: '浅色' },
  { id: 'dark', label: '深色' },
  { id: 'system', label: '跟随系统' },
];

function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const BILLING_KIND_OPTIONS = [
  { value: 'subscription', label: '订阅' },
  { value: 'api', label: 'API' },
  { value: 'free', label: '免费' },
];

function approxPrefix(show: boolean): string {
  return show ? '<span class="approx" title="ChatGPT 为估算">~</span>' : '';
}

function stackedBars(series: ReturnType<typeof tokenTrend>): string {
  if (series.length === 0) return '<div class="empty">暂无趋势数据</div>';
  const width = 1000;
  const height = 148;
  const pad = { l: 8, r: 8, t: 8, b: 4 };
  const innerW = width - pad.l - pad.r;
  const innerH = height - pad.t - pad.b;
  const max = Math.max(1, ...series.map((p) => p.totalTokens));
  const gap = series.length > 40 ? 1.5 : 3;
  const barW = Math.max(2, innerW / series.length - gap);
  const labelEvery = series.length <= 12 ? 1 : series.length <= 28 ? 2 : series.length <= 45 ? 3 : 0;
  const baseline = `<line x1="${pad.l}" y1="${pad.t + innerH}" x2="${width - pad.r}" y2="${pad.t + innerH}" stroke="currentColor" stroke-opacity="0.18" />`;
  const bars = series
    .map((point, i) => {
      const x = pad.l + i * (innerW / series.length) + gap / 2;
      const codingH = (point.codingTokens / max) * innerH;
      const gptH = (point.chatgptTokens / max) * innerH;
      const yGpt = pad.t + innerH - gptH;
      const yCoding = yGpt - codingH;
      const codingRect =
        codingH > 0.5
          ? `<rect x="${x}" y="${yCoding}" width="${barW}" height="${codingH}" rx="2" fill="var(--coding)"></rect>`
          : '';
      const gptRect =
        gptH > 0.5
          ? `<rect x="${x}" y="${yGpt}" width="${barW}" height="${gptH}" fill="var(--chatgpt)"></rect>`
          : '';
      return `${codingRect}${gptRect}`;
    })
    .join('');
  const labels = series
    .map((point, i) => {
      const show = labelEvery > 0 && i % labelEvery === 0;
      return `<span>${show ? esc(point.label) : ''}</span>`;
    })
    .join('');
  return `<div class="trend-chart">
    <svg class="trend-svg" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none">${baseline}${bars}</svg>
    <div class="trend-labels">${labels}</div>
  </div>`;
}

const ICON_REFRESH = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>`;
const ICON_GEAR = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>`;

function switchControl(id: string, checked: boolean): string {
  return `<label class="switch"><input id="${id}" type="checkbox" ${checked ? 'checked' : ''} /><span class="switch-ui"></span></label>`;
}

function setIcon(svg: string, tone = ''): string {
  return `<div class="set-icon ${tone}">${svg}</div>`;
}

function setRow(title: string, desc: string, control: string, icon: string): string {
  return `<div class="set-row">
    ${icon}
    <div class="set-copy">
      <div class="set-title">${title}</div>
      ${desc ? `<div class="set-desc">${desc}</div>` : ''}
    </div>
    <div class="set-control">${control}</div>
  </div>`;
}

function deviceHostname(): string {
  const saved = remote?.config.hostname?.trim();
  if (saved) return saved;
  return remote?.defaultHostname?.trim() || '';
}

function appVersion(): string {
  return remote?.appVersion || '0.2.0';
}

function updateStatusLabel(): string {
  if (updateCheck.status === 'checking') return '正在检查更新…';
  if (updateCheck.status === 'current') return `已是最新版本（v${appVersion()}）`;
  if (updateCheck.status === 'available') return `发现新版本 ${updateCheck.latest}`;
  if (updateCheck.status === 'error') return updateCheck.error || '检查更新失败';
  return '点击检查更新，查看 GitHub 上的最新版本';
}

const ICON_POWER = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2v10"/><path d="M8.5 4.2a8 8 0 1 0 7 0"/></svg>`;
const ICON_PALETTE = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M12 3a9 9 0 0 0 0 18"/></svg>`;
const ICON_COIN = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M12 7v10"/></svg>`;
const ICON_CHAT = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 6h16v10H8l-4 4V6z"/></svg>`;
const ICON_CLOUD = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M7 18h10a4 4 0 0 0 .5-8 6 6 0 0 0-11.5 2A3.5 3.5 0 0 0 7 18z"/></svg>`;
const ICON_CURSOR = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 4l16 7-7 2-2 7-7-16z"/></svg>`;
const ICON_FOLDER = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 7h6l2 2h10v10H3z"/></svg>`;
const ICON_BILLING = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 10h18"/></svg>`;

function distList(
  rows: ReturnType<typeof distribution>,
  options: { approxKey?: string; labelFor?: (key: string) => string } = {},
): string {
  if (rows.length === 0) return '<div class="empty">暂无分布数据</div>';
  const top = rows.slice(0, 10);
  const rest = rows.slice(10).reduce((sum, row) => sum + row.tokens, 0);
  const shown = rest > 0 ? [...top, { key: '其他', tokens: rest }] : top;
  const max = Math.max(1, ...shown.map((row) => row.tokens));
  const labelFor = options.labelFor ?? ((key: string) => key);
  return shown
    .map((row) => {
      const isGpt = options.approxKey ? row.key === options.approxKey : false;
      const label = row.key === '其他' ? '其他' : labelFor(row.key);
      return `<div class="bar-row">
        <div title="${esc(label)}">${esc(label)}${isGpt ? ' ~' : ''}</div>
        <div class="bar-track"><div class="bar-fill${isGpt ? ' chatgpt' : ''}" style="width:${(row.tokens / max) * 100}%"></div></div>
        <div>${isGpt ? '~' : ''}${esc(formatCompactTokens(row.tokens))}</div>
      </div>`;
    })
    .join('');
}

function cleanSnapshot(snapshot: Snapshot): Snapshot {
  return {
    ...snapshot,
    buckets: dropCloudRows(snapshot.buckets ?? []),
    sessions: dropCloudRows(snapshot.sessions ?? []),
  };
}

function sliceData(snapshot: Snapshot) {
  const now = new Date();
  const window = timeRangeWindow(range, now);
  const timedBuckets = filterBucketsByTime(snapshot.buckets, window);
  const timedSessions = filterSessionsByTime(snapshot.sessions, window);
  const facets = {
    hostnames: hostFilter ? [hostFilter] : [],
    sources: sourceFilter ? [sourceFilter] : [],
    models: modelFilter ? [modelFilter] : [],
    projects: projectFilter ? [projectFilter] : [],
  };
  const scopedBuckets = filterByFacets(timedBuckets, facets);
  const scopedSessions = filterSessionsByFacets(timedSessions, facets);
  const viewBuckets = filterBuckets(scopedBuckets, view, includeChatgpt);
  const viewSessions = filterSessions(scopedSessions, view, includeChatgpt);
  return {
    optionBuckets: timedBuckets,
    costBuckets: scopedBuckets,
    buckets: viewBuckets,
    sessions: viewSessions,
    window,
    trendWindow: trendFillWindow(range, window, viewBuckets),
  };
}

function formatApi(line: CostLine): string {
  const money = formatMoney(line.api, currency);
  if (line.unpriced.length === 0) return money;
  const missing = unpricedLabel(line.unpriced);
  if (line.api === 0) return `未定价（${missing}）`;
  return `${money} · 未定价 ${missing}`;
}

function costPanel(breakdown: ReturnType<typeof costBreakdown>): string {
  const line = breakdown.total;
  return `
    <div class="cost-tile">
      <span class="cost-tile-label">订阅</span>
      <span class="cost-tile-value">${esc(formatMoney(line.subscription, currency))}</span>
    </div>
    <div class="cost-tile">
      <span class="cost-tile-label">API</span>
      <span class="cost-tile-value">${esc(formatApi(line))} <em>估算</em></span>
    </div>
  `;
}

function syncedAtLabel(): string {
  const syncedAt = remote?.snapshot?.syncedAt
    ? new Date(remote.snapshot.syncedAt).toLocaleString()
    : '尚未同步';
  return `上次同步 ${esc(syncedAt)}`;
}

function chrome(): string {
  return `
    <header class="chrome">
      <div class="chrome-row">
        <div class="brand">
          <img src="${logo}" alt="" />
          <span>AI Usage</span>
        </div>
        <div class="seg">
          ${VIEWS.map((item) => `<button type="button" data-view="${item.id}" class="${view === item.id ? 'active' : ''}">${item.label}</button>`).join('')}
        </div>
        <div class="seg">
          ${RANGES.map((item) => `<button type="button" data-range="${item.id}" class="${range === item.id ? 'active' : ''}">${item.label}</button>`).join('')}
        </div>
        <button id="refresh-btn" class="icon-btn" title="同步数据" ${refreshing ? 'disabled' : ''}>${ICON_REFRESH}</button>
        <button id="open-settings" class="icon-btn ${page === 'settings' ? 'active' : ''}" title="设置">${ICON_GEAR}</button>
        <span class="grow"></span>
        <div class="cost-tiles" id="cost-panel"></div>
      </div>
    </header>
  `;
}

function summaryGrid(
  cards: ReturnType<typeof summaryCards>,
  chatgptInPlay: boolean,
): string {
  if (view === 'chatgpt') {
    return `<div class="cards">
      <div class="card"><div class="label">Token 估计</div><div class="value">${approxPrefix(true)}${esc(formatCompactTokens(cards.totalTokens))}</div></div>
      <div class="card"><div class="label">消息数</div><div class="value">${esc(formatCompactTokens(cards.messageCount))}</div></div>
      <div class="card"><div class="label">会话数</div><div class="value">${esc(formatCompactTokens(cards.sessionCount))}</div></div>
      <div class="card"><div class="label">思考时间</div><div class="value">${esc(formatDuration(cards.activeSeconds))}</div></div>
    </div>`;
  }
  return `<div class="cards">
    <div class="card"><div class="label">总 Token</div><div class="value">${approxPrefix(chatgptInPlay)}${esc(formatCompactTokens(cards.totalTokens))}</div></div>
    <div class="card"><div class="label">输入 Token</div><div class="value">${approxPrefix(chatgptInPlay)}${esc(formatCompactTokens(cards.inputTokens))}</div></div>
    <div class="card"><div class="label">输出 Token</div><div class="value">${approxPrefix(chatgptInPlay)}${esc(formatCompactTokens(cards.outputTokens))}</div></div>
    <div class="card"><div class="label">缓存 Token</div><div class="value">${esc(formatCompactTokens(cards.cachedTokens))}</div></div>
    <div class="card"><div class="label">活跃时长</div><div class="value">${esc(formatDuration(cards.activeSeconds))}</div></div>
    <div class="card"><div class="label">总时长</div><div class="value">${esc(formatDuration(cards.durationSeconds))}</div></div>
    <div class="card"><div class="label">会话数</div><div class="value">${esc(formatCompactTokens(cards.sessionCount))}</div></div>
    <div class="card"><div class="label">消息数</div><div class="value">${esc(formatCompactTokens(cards.messageCount))}</div></div>
  </div>`;
}

function dashboardBody(snapshot: Snapshot): string {
  const missing = !remote || remote.missingSnapshot || !remote.snapshot;
  const hasChatgpt =
    snapshot.buckets.some((row) => row.source === 'chatgpt-web') ||
    snapshot.sessions.some((row) => row.source === 'chatgpt-web');
  const chatgptEmpty = view === 'chatgpt' && !hasChatgpt;
  const { optionBuckets, costBuckets, buckets, sessions, trendWindow } = sliceData(snapshot);
  const cards = summaryCards(buckets, sessions, includeCache);
  const chatgptInPlay =
    view === 'chatgpt' ||
    (view === 'all' && includeChatgpt && buckets.some((b) => b.source === 'chatgpt-web'));
  const trend = tokenTrend(buckets, usesHourlyTrend(range) ? 'hour' : 'day', trendWindow, includeCache);
  const hosts = uniqueValues(optionBuckets, 'hostname');
  const sources = uniqueValues(optionBuckets, 'source');
  const models = uniqueValues(optionBuckets, 'model');
  const projects = uniqueProjects(optionBuckets);
  const breakdown = costBreakdown({
    buckets: costBuckets,
    billing,
    includeChatgptInTotal: includeChatgpt,
    currency,
  });

  return `
    ${chrome()}
    <div class="filters">
      <div class="filter-field"><span>设备</span>${pickerMarkup('filter-host', withAllOption(hosts), hostFilter)}</div>
      <div class="filter-field"><span>工具</span>${pickerMarkup('filter-source', withAllOption(sources, sourceLabel), sourceFilter)}</div>
      <div class="filter-field"><span>模型</span>${pickerMarkup('filter-model', withAllOption(models), modelFilter)}</div>
      <div class="filter-field"><span>项目</span>${pickerMarkup('filter-project', withAllOption(projects, projectLabel), projectFilter, 'picker-wide')}</div>
      <span class="grow"></span>
      <span class="sync-meta">${syncedAtLabel()}</span>
    </div>
    <div class="content">
      ${missing ? `<div class="banner">暂无本地快照。请点击刷新采集本机用量（写入 ${esc(remote?.home ?? '~/.ai-usage')}）。</div>` : ''}
      ${chatgptEmpty ? `<div class="banner">对话分段还没有数据。请到设置里加载 ChatGPT 网页扩展。</div>` : ''}
      ${remote?.lastError ? `<div class="error">上次更新失败：${esc(remote.lastError)}</div>` : ''}
      ${snapshot.cloud?.error ? `<div class="error">${esc(snapshot.cloud.error)}</div>` : ''}
      ${summaryGrid(cards, chatgptInPlay)}
      <div class="chart-card">
        <h2>Token 趋势</h2>
        <div class="legend">
          ${
            view === 'chatgpt'
              ? '<span><i class="swatch chatgpt"></i>对话估算</span>'
              : `<span><i class="swatch coding"></i>编程</span>
          <span><i class="swatch chatgpt"></i>对话估算</span>`
          }
        </div>
        <div class="trend">${stackedBars(trend)}</div>
      </div>
      <div class="dist-grid">
        <section><h2>按设备</h2>${distList(distribution(buckets, 'hostname', includeCache))}</section>
        <section><h2>按工具</h2>${distList(distribution(buckets, 'source', includeCache), { approxKey: 'chatgpt-web', labelFor: sourceLabel })}</section>
        <section><h2>按模型</h2>${distList(distribution(buckets, 'model', includeCache))}</section>
        <section><h2>按项目</h2>${distList(distribution(buckets, 'project', includeCache), { labelFor: projectLabel })}</section>
      </div>
    </div>
    <template id="cost-html">${costPanel(breakdown)}</template>
  `;
}

function billingFields(source: string, cfg: SourceBilling | undefined): string {
  const kind = cfg?.kind ?? 'free';
  if (kind === 'subscription') {
    return `<label>月费 <input data-bill-monthly="${esc(source)}" type="number" min="0" step="0.01" value="${esc(cfg?.monthly ?? '')}" /></label>`;
  }
  if (kind === 'api') {
    return `
      <label>输入 / 百万 <input data-bill-in="${esc(source)}" type="number" min="0" step="0.01" value="${esc(cfg?.inputPerMillion ?? '')}" placeholder="内置" /></label>
      <label>输出 / 百万 <input data-bill-out="${esc(source)}" type="number" min="0" step="0.01" value="${esc(cfg?.outputPerMillion ?? '')}" placeholder="内置" /></label>
    `;
  }
  return '<span class="muted">不计入消费</span>';
}

function billingRow(source: string): string {
  const cfg = billing[source];
  return `<div class="billing-row">
    <div class="billing-name">${esc(sourceLabel(source))}</div>
    ${pickerMarkup(`bill-kind-${source}`, BILLING_KIND_OPTIONS, cfg?.kind ?? 'free')}
    <div class="billing-fields">${billingFields(source, cfg)}</div>
  </div>`;
}

function cloudStatusClass(): string {
  const cloud = remote?.snapshot?.cloud;
  if (cloud?.error) return 'error';
  if (cloud?.pulled) return 'ok';
  return 'muted';
}

function generalPanel(): string {
  const otherSources = BILLING_SOURCES.filter((source) => !FEATURED_SOURCES.includes(source));
  return `
    <section class="set-panel">
      ${setRow(
        '开机自启',
        '登录后静默运行，只显示菜单栏托盘，不打开窗口',
        switchControl('autostart-toggle', autostartOn),
        setIcon(ICON_POWER, 'tone-green'),
      )}
      ${setRow(
        '外观主题',
        '浅色、深色，或跟随系统',
        `<div class="seg">${THEME_PILLS.map(
          (item) =>
            `<button type="button" data-theme="${item.id}" class="${themePref === item.id ? 'active' : ''}">${item.label}</button>`,
        ).join('')}</div>`,
        setIcon(ICON_PALETTE, 'tone-blue'),
      )}
      ${setRow(
        '货币',
        '订阅月费和 API 估算的展示货币',
        `<div class="seg">
          <button type="button" data-currency="USD" class="${currency === 'USD' ? 'active' : ''}">USD</button>
          <button type="button" data-currency="CNY" class="${currency === 'CNY' ? 'active' : ''}">CNY</button>
        </div>`,
        setIcon(ICON_COIN, 'tone-amber'),
      )}
      ${setRow(
        '总 Token 口径',
        '首页合计、趋势、分布和菜单栏使用同一套算法',
        `<div class="seg">
          <button type="button" data-cache-total="0" class="${includeCache ? '' : 'active'}">输入+输出</button>
          <button type="button" data-cache-total="1" class="${includeCache ? 'active' : ''}">输入+输出+缓存</button>
        </div>`,
        setIcon(ICON_BILLING, 'tone-blue'),
      )}
      ${setRow(
        'ChatGPT 估算计入总 Token',
        '只影响「全部」视图和托盘合计',
        switchControl('include-toggle', includeChatgpt),
        setIcon(ICON_CHAT, 'tone-green'),
      )}
      ${setRow(
        '数据目录',
        esc(remote?.home ?? ''),
        '',
        setIcon(ICON_FOLDER, 'tone-slate'),
      )}
    </section>
    <section class="set-panel">
      ${setRow(
        '按工具付费',
        '订阅只展示你填的月费。API 按当前时间范围内 input+output+思考 Token（不含缓存读）× 单价估算。',
        '',
        setIcon(ICON_BILLING, 'tone-blue'),
      )}
      <div class="set-stack">
        ${FEATURED_SOURCES.map(billingRow).join('')}
        <details class="more-tools">
          <summary>其他工具</summary>
          ${otherSources.map(billingRow).join('')}
        </details>
      </div>
    </section>
  `;
}

function advancedPanel(): string {
  const extensionReady = Boolean(remote?.chatgptExtensionReady);
  const cursorReady = Boolean(remote?.cursorDeviceReady);
  return `
    <section class="set-panel">
      ${setRow(
        '多设备同步',
        '四台填写同一套 Worker 地址和密钥。数据在你自己的 Cloudflare D1。两台电脑系统名相同时，请改设备名。',
        `<span class="${cloudStatusClass()}">${esc(cloudSyncLabel(remote?.config ?? {}, remote?.snapshot?.cloud))}</span>`,
        setIcon(ICON_CLOUD, 'tone-blue'),
      )}
      <div class="set-stack">
        <label class="stack">同步地址
          <input id="sync-api-url" type="url" placeholder="https://ai-usage.example.workers.dev" value="${esc(remote?.config.apiUrl ?? '')}" />
        </label>
        <label class="stack">密钥
          <input id="sync-api-key" type="password" autocomplete="off" value="${esc(remote?.config.apiKey ?? '')}" />
        </label>
        <label class="stack">本机设备名
          <input id="sync-hostname" type="text" placeholder="${esc(remote?.defaultHostname ?? '')}" value="${esc(deviceHostname())}" />
        </label>
      </div>
    </section>
    <section class="set-panel">
      ${setRow(
        'Cursor',
        cursorReady
          ? '已在采集本机 Cursor 用量。'
          : '应用启动时会自动安装 Cursor hook。之后在 Cursor 里对话就会记入本机用量。',
        cursorReady
          ? '<span class="ok">已就绪</span>'
          : '<button type="button" id="install-cursor-hook" class="ghost-btn">重新安装</button>',
        setIcon(ICON_CURSOR, 'tone-slate'),
      )}
    </section>
    <section class="set-panel">
      ${setRow(
        'ChatGPT 网页扩展',
        extensionReady
          ? '已在采集对话用量。'
          : '应用启动时会自动登记浏览器 Native Host。用 Chrome / Edge 加载已解压扩展后打开 chatgpt.com。',
        '<button type="button" id="open-extension" class="ghost-btn">打开扩展目录</button>',
        setIcon(ICON_CHAT, 'tone-green'),
      )}
      ${
        extensionReady
          ? ''
          : `<div class="set-stack">
              <ol>
                <li>打开 Chrome / Edge 的扩展页，打开「开发者模式」</li>
                <li>选择「加载已解压的扩展程序」，选下面这个目录</li>
                <li>打开 chatgpt.com 即可开始记录</li>
              </ol>
              <p><code>${esc(remote?.extensionPath ?? '')}</code></p>
            </div>`
      }
    </section>
  `;
}

function aboutPanel(): string {
  const notes = updateCheck.notes
    ? `<pre class="release-notes">${esc(updateCheck.notes)}</pre>`
    : '';
  return `
    <section class="set-panel about-hero">
      <div class="about-brand">
        <img src="${logo}" alt="" />
        <div>
          <div class="about-name">AI Usage</div>
          <div class="about-version">版本 v${esc(appVersion())}</div>
          <div class="${updateCheck.status === 'error' ? 'error' : updateCheck.status === 'available' ? 'ok' : 'muted'}">${esc(updateStatusLabel())}</div>
        </div>
      </div>
      <div class="about-actions">
        <button type="button" id="open-github" class="ghost-btn">GitHub</button>
        <button type="button" id="open-changelog" class="ghost-btn">更新日志</button>
        <button type="button" id="check-update" class="primary-btn" ${updateCheck.status === 'checking' ? 'disabled' : ''}>检查更新</button>
      </div>
      ${notes}
    </section>
  `;
}

function settingsBody(): string {
  const panel =
    settingsTab === 'advanced'
      ? advancedPanel()
      : settingsTab === 'about'
        ? aboutPanel()
        : generalPanel();
  return `
    <div class="settings-shell">
    <header class="settings-chrome">
      <button type="button" id="back-dashboard" class="back-btn" title="返回仪表盘">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 18l-6-6 6-6"/></svg>
      </button>
      <h1>设置</h1>
      <span class="grow"></span>
      <span class="sync-meta">${syncedAtLabel()}</span>
    </header>
    <div class="settings-tabbar">
      <nav class="settings-tabs">
        ${SETTINGS_TABS.map(
          (item) =>
            `<button type="button" data-settings-tab="${item.id}" class="${settingsTab === item.id ? 'active' : ''}">${item.label}</button>`,
        ).join('')}
      </nav>
    </div>
    <div class="settings-scroll">
      <div class="settings-inner">
      ${panel}
      </div>
    </div>
    </div>
  `;
}

function render(root: HTMLElement) {
  applyTheme(themePref);
  closeAllPickers();
  const content = root.querySelector('.settings-scroll, .content') as HTMLElement | null;
  const scroll = page === 'settings' ? content?.scrollTop ?? 0 : 0;
  const snapshot = cleanSnapshot(remote?.snapshot ?? { buckets: [], sessions: [] });
  root.innerHTML = page === 'settings' ? settingsBody() : dashboardBody(snapshot);
  if (page === 'dashboard') {
    const cost = root.querySelector('#cost-html');
    const panel = root.querySelector('#cost-panel');
    if (cost && panel) panel.innerHTML = cost.innerHTML;
  }
  bind(root);
  if (page === 'settings') {
    const next = root.querySelector('.settings-scroll') as HTMLElement | null;
    if (next) next.scrollTop = scroll;
  }
}

function bind(root: HTMLElement) {
  root.querySelectorAll<HTMLButtonElement>('[data-view]').forEach((btn) => {
    btn.addEventListener('click', () => {
      view = btn.dataset.view as View;
      page = 'dashboard';
      render(root);
    });
  });
  root.querySelectorAll<HTMLButtonElement>('[data-range]').forEach((btn) => {
    btn.addEventListener('click', () => {
      range = btn.dataset.range as TimeRangeId;
      render(root);
    });
  });
  root.querySelector('#open-settings')?.addEventListener('click', () => {
    page = 'settings';
    render(root);
  });
  root.querySelector('#back-dashboard')?.addEventListener('click', () => {
    page = 'dashboard';
    render(root);
  });
  root.querySelectorAll<HTMLButtonElement>('[data-settings-tab]').forEach((btn) => {
    btn.addEventListener('click', () => {
      settingsTab = btn.dataset.settingsTab as SettingsTab;
      render(root);
    });
  });
  root.querySelector('#include-toggle')?.addEventListener('change', async (event) => {
    includeChatgpt = (event.target as HTMLInputElement).checked;
    await persistConfig({ includeChatgptInTotal: includeChatgpt }, false);
  });
  const bindSyncField = (id: string, key: 'apiUrl' | 'apiKey' | 'hostname') => {
    root.querySelector<HTMLInputElement>(`#${id}`)?.addEventListener('change', async (event) => {
      const value = (event.target as HTMLInputElement).value.trim();
      await persistConfig({ [key]: value }, false);
    });
  };
  bindSyncField('sync-api-url', 'apiUrl');
  bindSyncField('sync-api-key', 'apiKey');
  bindSyncField('sync-hostname', 'hostname');
  root.querySelector('#autostart-toggle')?.addEventListener('change', async (event) => {
    autostartOn = (event.target as HTMLInputElement).checked;
    try {
      if (autostartOn) await enable();
      else await disable();
    } catch {
      // OS hook failed; still persist the user's intent.
    }
    await persistConfig({ autostart: autostartOn }, false);
  });
  root.querySelectorAll<HTMLButtonElement>('[data-theme]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      themePref = btn.dataset.theme as ThemePref;
      applyTheme(themePref);
      root.querySelectorAll<HTMLButtonElement>('[data-theme]').forEach((item) => {
        item.classList.toggle('active', item === btn);
      });
      await persistConfig({ theme: themePref }, false);
    });
  });
  root.querySelectorAll<HTMLButtonElement>('[data-currency]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      currency = btn.dataset.currency as Currency;
      root.querySelectorAll<HTMLButtonElement>('[data-currency]').forEach((item) => {
        item.classList.toggle('active', item === btn);
      });
      await persistConfig({ currency }, false);
    });
  });
  root.querySelectorAll<HTMLButtonElement>('[data-cache-total]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      includeCache = btn.dataset.cacheTotal === '1';
      root.querySelectorAll<HTMLButtonElement>('[data-cache-total]').forEach((item) => {
        item.classList.toggle('active', item === btn);
      });
      await persistConfig({ includeCacheInTotal: includeCache }, false);
    });
  });
  const bindBillingFields = (scope: ParentNode) => {
    scope.querySelectorAll<HTMLInputElement>('[data-bill-monthly]').forEach((input) => {
      input.addEventListener('change', async () => {
        const source = input.dataset.billMonthly;
        if (!source) return;
        billing = {
          ...billing,
          [source]: { kind: 'subscription', ...billing[source], monthly: Number(input.value) },
        };
        await persistConfig({ billing }, false);
      });
    });
    scope.querySelectorAll<HTMLInputElement>('[data-bill-in]').forEach((input) => {
      input.addEventListener('change', async () => {
        const source = input.dataset.billIn;
        if (!source) return;
        billing = { ...billing, [source]: { kind: 'api', ...billing[source], inputPerMillion: Number(input.value) } };
        await persistConfig({ billing }, false);
      });
    });
    scope.querySelectorAll<HTMLInputElement>('[data-bill-out]').forEach((input) => {
      input.addEventListener('change', async () => {
        const source = input.dataset.billOut;
        if (!source) return;
        billing = { ...billing, [source]: { kind: 'api', ...billing[source], outputPerMillion: Number(input.value) } };
        await persistConfig({ billing }, false);
      });
    });
  };
  bindBillingFields(root);
  bindPickers(root, (id, value) => {
    if (id === 'filter-host') {
      hostFilter = value;
      render(root);
      return;
    }
    if (id === 'filter-source') {
      sourceFilter = value;
      render(root);
      return;
    }
    if (id === 'filter-model') {
      modelFilter = value;
      render(root);
      return;
    }
    if (id === 'filter-project') {
      projectFilter = value;
      render(root);
      return;
    }
    if (!id.startsWith('bill-kind-')) return;
    const source = id.slice('bill-kind-'.length);
    const next: SourceBilling = { ...(billing[source] ?? { kind: 'free' }), kind: value as SourceBilling['kind'] };
    billing = { ...billing, [source]: next };
    const fields = document.getElementById(id)?.closest('.billing-row')?.querySelector('.billing-fields');
    if (fields) {
      fields.innerHTML = billingFields(source, next);
      bindBillingFields(fields);
    }
    void persistConfig({ billing }, false);
  });
  root.querySelector('#open-extension')?.addEventListener('click', async () => {
    if (!remote?.extensionPath) return;
    try {
      await invoke('open_path', { path: remote.extensionPath });
    } catch {
      // Finder open can fail if the folder is missing.
    }
  });
  root.querySelector('#install-cursor-hook')?.addEventListener('click', async () => {
    try {
      await invoke('install_cursor_hook');
      remote = await invoke<DashboardState>('get_state');
      applyRemote();
    } catch (err) {
      if (remote) remote.lastError = String(err);
    }
    render(root);
  });
  const openExternal = async (url: string) => {
    try {
      await invoke('open_url', { url });
    } catch {
      try {
        await invoke('open_path', { path: url });
      } catch {
        window.open(url, '_blank');
      }
    }
  };
  root.querySelector('#open-github')?.addEventListener('click', () => {
    void openExternal(GITHUB_URL);
  });
  root.querySelector('#open-changelog')?.addEventListener('click', () => {
    void openExternal(updateCheck.url || GITHUB_RELEASES_URL);
  });
  root.querySelector('#check-update')?.addEventListener('click', () => {
    void checkForUpdate();
  });
  root.querySelector('#refresh-btn')?.addEventListener('click', () => void refresh());
}

async function checkForUpdate() {
  updateCheck = { status: 'checking' };
  const root = document.querySelector<HTMLElement>('#app');
  if (root) render(root);
  try {
    const payload = await invoke<unknown>('check_for_update');
    const release = parseGithubRelease(payload);
    if (!release) {
      updateCheck = { status: 'error', error: '无法解析更新信息', url: GITHUB_RELEASES_URL };
    } else {
      const status = updateStatus(appVersion(), release.tagName);
      updateCheck = {
        status: status === 'available' ? 'available' : 'current',
        latest: release.tagName,
        notes: release.notes,
        url: release.url,
      };
    }
  } catch (err) {
    const message = String(err).trim() || '网络不可用，无法检查更新';
    updateCheck = {
      status: 'error',
      error: message.replace(/^.*?:\s*/, ''),
      url: GITHUB_RELEASES_URL,
    };
  }
  const next = document.querySelector<HTMLElement>('#app');
  if (next) render(next);
}

async function persistConfig(patch: Record<string, unknown>, rerender = true) {
  try {
    remote = await invoke<DashboardState>('save_config', { patch });
    applyRemote();
  } catch (err) {
    if (remote) remote.lastError = String(err);
  }
  if (!rerender) return;
  const root = document.querySelector<HTMLElement>('#app');
  if (root) render(root);
}

function applyRemote() {
  if (!remote) return;
  includeChatgpt = remote.config.includeChatgptInTotal !== false;
  includeCache = remote.config.includeCacheInTotal === true;
  if (typeof remote.config.autostart === 'boolean') autostartOn = remote.config.autostart;
  if (remote.config.theme === 'light' || remote.config.theme === 'dark' || remote.config.theme === 'system') {
    themePref = remote.config.theme;
  }
  if (remote.config.currency === 'USD' || remote.config.currency === 'CNY') {
    currency = remote.config.currency;
  }
  if (remote.config.billing && typeof remote.config.billing === 'object') {
    billing = remote.config.billing;
  }
  applyTheme(themePref);
}

async function load() {
  remote = await invoke<DashboardState>('get_state');
  applyRemote();
  const root = document.querySelector<HTMLElement>('#app');
  if (root) render(root);
}

async function refresh() {
  if (refreshing) return;
  refreshing = true;
  const btn = document.querySelector<HTMLButtonElement>('#refresh-btn');
  if (btn) btn.disabled = true;
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
    if (next) render(next);
  }
}

export async function startDashboard() {
  const root = document.querySelector<HTMLElement>('#app');
  if (!root) return;
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (themePref === 'system') applyTheme(themePref);
  });
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
    render(root);
  }
  try {
    await listen('snapshot-updated', () => {
      void load();
    });
  } catch {
    // Browser preview has no Tauri IPC.
  }
}
