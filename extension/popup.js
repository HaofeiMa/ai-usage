(() => {
  'use strict';
  const core = globalThis.ChatGPTProbeCore;
  const $ = id => document.getElementById(id);
  const fmtNum = n => Math.round(Number(n) || 0).toLocaleString();
  const fmtDuration = seconds => {
    const s = Math.round(Number(seconds) || 0);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    const rem = s % 60;
    if (m < 60) return `${m}m ${rem}s`;
    const h = Math.floor(m / 60);
    return `${h}h ${m % 60}m`;
  };

  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

  function localDayRange(now = new Date()) {
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const end = new Date(start);
    end.setDate(end.getDate() + 1);
    return [start.getTime() / 1000, end.getTime() / 1000];
  }

  async function mergeDebug(patch) {
    const { debug = {} } = await chrome.storage.local.get(['debug']);
    await chrome.storage.local.set({ debug: { ...debug, ...patch } });
  }

  async function ensureCollectorInjected() {
    const openedAt = Date.now();
    await mergeDebug({ popupOpenedAt: openedAt, injectionStatus: 'starting', injectionError: null });

    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab || !Number.isInteger(tab.id)) throw new Error('No active browser tab found');

      let hostname = null;
      try { hostname = tab.url ? new URL(tab.url).hostname : null; } catch (_) {}
      if (hostname && hostname !== 'chatgpt.com') {
        await mergeDebug({
          injectionStatus: 'not-chatgpt-tab',
          injectionTabId: tab.id,
          injectionPage: tab.url || null,
          injectionAt: Date.now()
        });
        return false;
      }

      // Install the storage bridge first, so it cannot miss the MAIN-world
      // hook-ready event. activeTab lets this work even when persistent site
      // access is configured as "On click" in Chrome.
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        world: 'ISOLATED',
        files: ['core.js', 'bridge.js']
      });
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        world: 'MAIN',
        files: ['core.js', 'page-hook.js']
      });

      await mergeDebug({
        injectionStatus: 'injected',
        injectionTabId: tab.id,
        injectionPage: tab.url || null,
        injectionAt: Date.now(),
        injectionError: null
      });
      return true;
    } catch (error) {
      await mergeDebug({
        injectionStatus: 'error',
        injectionAt: Date.now(),
        injectionError: error && error.message ? String(error.message) : String(error)
      });
      return false;
    }
  }

  async function render() {
    const { snapshots = {}, debug = {} } = await chrome.storage.local.get(['snapshots', 'debug']);
    const [start, end] = localDayRange();
    const stats = core.aggregateForRange(snapshots, start, end);
    $('dateLabel').textContent = new Intl.DateTimeFormat(undefined, { weekday:'short', month:'short', day:'numeric' }).format(new Date());
    $('prompts').textContent = fmtNum(stats.prompts);
    $('replies').textContent = fmtNum(stats.assistantReplies);
    $('modelSteps').textContent = fmtNum(stats.modelSteps);
    $('conversations').textContent = fmtNum(stats.conversations);
    $('thinking').textContent = fmtDuration(stats.thinkingSeconds);
    $('userTokens').textContent = `~${fmtNum(stats.visibleUserTokens)}`;
    $('assistantTokens').textContent = `~${fmtNum(stats.visibleAssistantTokens)}`;
    $('contextTokens').textContent = `~${fmtNum(stats.estimatedContextInputTokens)}`;

    const replyModelEntries = Object.entries(stats.replyModels).sort((a,b) => b[1] - a[1]);
    $('replyModels').className = replyModelEntries.length ? 'models' : 'models empty';
    $('replyModels').innerHTML = replyModelEntries.length
      ? replyModelEntries.map(([model,count]) => `<span class="model-chip">${escapeHtml(model)} · ${count} final</span>`).join('')
      : 'No final-reply model metadata observed today.';

    const stepModelEntries = Object.entries(stats.stepModels).sort((a,b) => b[1] - a[1]);
    $('stepModels').className = stepModelEntries.length ? 'models' : 'models empty';
    $('stepModels').innerHTML = stepModelEntries.length
      ? stepModelEntries.map(([model,count]) => `<span class="model-chip">${escapeHtml(model)} · ${count} steps</span>`).join('')
      : 'No model-step metadata observed today.';

    const recent = stats.conversationsDetail.slice(0, 5);
    $('recent').className = recent.length ? 'recent' : 'recent empty';
    $('recent').innerHTML = recent.length ? recent.map(c => `
      <div class="conv">
        <div class="conv-title" title="${escapeHtml(c.title)}">${escapeHtml(c.title)}</div>
        <div class="conv-meta">${c.prompts} prompts · ${c.replies} final replies · ${c.modelSteps} model steps · ${fmtDuration(c.thinkingSeconds)} thinking · ~${fmtNum(c.visibleTokens)} visible tok.</div>
      </div>`).join('') : 'Open or continue a ChatGPT conversation to collect data.';

    const legacyWarning = $('legacyWarning');
    if (stats.legacySnapshotsSkipped > 0) {
      legacyWarning.hidden = false;
      legacyWarning.textContent = `${stats.legacySnapshotsSkipped} snapshot${stats.legacySnapshotsSkipped === 1 ? '' : 's'} from v0.3 need refresh. Reopen those conversations once to classify final replies and model steps accurately.`;
    } else {
      legacyWarning.hidden = true;
      legacyWarning.textContent = '';
    }

    const seen = Boolean(debug.lastObservedAt);
    if (seen) {
      $('status').textContent = 'Observer active';
    } else if (debug.lastSyncStatus === 'error') {
      $('status').textContent = 'Sync error';
    } else if (debug.injectionStatus === 'error') {
      $('status').textContent = 'Injection error';
    } else if (debug.injectionStatus === 'not-chatgpt-tab') {
      $('status').textContent = 'Open ChatGPT tab';
    } else if (debug.hookReadyAt) {
      $('status').textContent = 'Hook ready';
    } else if (debug.injectionStatus === 'injected') {
      $('status').textContent = 'Injected · syncing';
    } else {
      $('status').textContent = 'No data yet';
    }
    $('debugText').textContent = JSON.stringify(debug, null, 2) || 'No observer events yet.';
  }

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
  }

  $('resetBtn').addEventListener('click', async () => {
    if (!confirm('Delete all locally collected Workload Probe data?')) return;
    await chrome.storage.local.remove(['snapshots', 'debug']);
    await render();
  });

  (async () => {
    await ensureCollectorInjected();
    // Allow hook-ready / sync-status / conversation events to cross into the
    // isolated bridge and reach chrome.storage.local before rendering.
    await sleep(900);
    await render();
  })();
})();
