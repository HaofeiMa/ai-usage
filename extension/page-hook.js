(() => {
  'use strict';

  const EVENT_SOURCE = 'chatgpt-workload-probe';
  const existingHook = globalThis.__CWP_PAGE_HOOK__;
  if (existingHook) {
    window.postMessage({
      source: EVENT_SOURCE,
      type: 'hook-ready',
      observedAt: Date.now(),
      reinjected: true
    }, '*');
    if (typeof existingHook.syncCurrentConversation === 'function') {
      existingHook.syncCurrentConversation('popup-reinject');
    }
    return;
  }
  const core = globalThis.ChatGPTProbeCore;
  const nativeFetch = typeof window.fetch === 'function' ? window.fetch : null;
  const NativeXHR = window.XMLHttpRequest;

  let accessToken = null;
  let accessTokenAt = 0;
  let syncTimer = null;
  let syncInFlight = null;
  let lastSyncAt = 0;

  const requestUrl = value => {
    try {
      if (typeof value === 'string') return value;
      if (value instanceof URL) return value.href;
      if (value && typeof value.url === 'string') return value.url;
    } catch (_) {}
    return '';
  };

  const requestMethod = (input, init) => {
    const fromInit = init && init.method;
    const fromRequest = input && typeof input === 'object' && input.method;
    return String(fromInit || fromRequest || 'GET').toUpperCase();
  };

  const isConversationDetailUrl = value => {
    const url = requestUrl(value);
    return /\/backend-api\/conversation\/[0-9a-f-]{20,}(?:[/?#]|$)/i.test(url);
  };

  const isConversationStreamUrl = value => {
    const url = requestUrl(value);
    return /\/backend-api\/(?:f\/)?conversation(?:[/?#]|$)/i.test(url);
  };

  const currentConversationId = () => {
    if (core && typeof core.extractConversationId === 'function') {
      return core.extractConversationId(location.href);
    }
    const match = location.pathname.match(/\/c\/([0-9a-f-]{20,})(?:\/|$)/i);
    return match ? match[1] : null;
  };

  const emitStatus = (status, details = {}) => {
    window.postMessage({
      source: EVENT_SOURCE,
      type: 'sync-status',
      status,
      observedAt: Date.now(),
      page: location.href,
      ...details
    }, '*');
  };

  const emitConversation = (payload, transport, url) => {
    if (!payload || typeof payload !== 'object' || !payload.mapping || !payload.current_node) return false;
    window.postMessage({
      source: EVENT_SOURCE,
      type: 'conversation',
      transport,
      url,
      payload,
      observedAt: Date.now()
    }, '*');
    return true;
  };

  async function getAccessToken(force = false) {
    const maxAgeMs = 8 * 60 * 1000;
    if (!force && accessToken && Date.now() - accessTokenAt < maxAgeMs) return accessToken;
    if (!nativeFetch) throw new Error('window.fetch unavailable');

    const response = await nativeFetch.call(window, '/api/auth/session', {
      method: 'GET',
      credentials: 'include',
      cache: 'no-store',
      headers: { accept: 'application/json' }
    });
    if (!response.ok) throw new Error(`auth session HTTP ${response.status}`);
    const session = await response.json();
    const token = session && (session.accessToken || session.access_token);
    if (!token || typeof token !== 'string') throw new Error('auth session returned no access token');
    accessToken = token;
    accessTokenAt = Date.now();
    return token;
  }

  async function fetchConversationSnapshot(id, token) {
    return nativeFetch.call(window, `/backend-api/conversation/${encodeURIComponent(id)}`, {
      method: 'GET',
      credentials: 'include',
      cache: 'no-store',
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${token}`
      }
    });
  }

  async function syncCurrentConversation(reason = 'manual') {
    const id = currentConversationId();
    if (!id || !nativeFetch) return;

    if (syncInFlight) return syncInFlight;
    if (Date.now() - lastSyncAt < 2500 && reason !== 'initial') return;

    syncInFlight = (async () => {
      emitStatus('syncing', { conversationId: id, reason });
      try {
        let token = await getAccessToken(false);
        let response = await fetchConversationSnapshot(id, token);

        if (response.status === 401 || response.status === 403) {
          accessToken = null;
          accessTokenAt = 0;
          token = await getAccessToken(true);
          response = await fetchConversationSnapshot(id, token);
        }

        if (!response.ok) throw new Error(`conversation snapshot HTTP ${response.status}`);
        const payload = await response.json();
        const accepted = emitConversation(payload, 'active-sync', response.url || location.href);
        if (!accepted) throw new Error('conversation snapshot missing mapping/current_node');
        emitStatus('ok', { conversationId: id, reason, httpStatus: response.status });
      } catch (error) {
        emitStatus('error', {
          conversationId: id,
          reason,
          error: error && error.message ? String(error.message) : String(error)
        });
      } finally {
        lastSyncAt = Date.now();
        syncInFlight = null;
      }
    })();

    return syncInFlight;
  }

  function scheduleSync(reason, delayMs = 500) {
    clearTimeout(syncTimer);
    syncTimer = setTimeout(() => syncCurrentConversation(reason), delayMs);
  }

  if (nativeFetch) {
    window.fetch = async function (...args) {
      const response = await nativeFetch.apply(this, args);
      const method = requestMethod(args[0], args[1]);

      if (method === 'GET' && isConversationDetailUrl(args[0])) {
        try {
          const clone = response.clone();
          clone.json()
            .then(data => emitConversation(data, 'fetch', response.url || requestUrl(args[0])))
            .catch(() => {});
        } catch (_) {}
      }

      if (method === 'POST' && isConversationStreamUrl(args[0])) {
        // A fetch response resolves when headers arrive, before ChatGPT's SSE stream
        // has necessarily finished. Read only a cloned stream, then refresh one
        // canonical conversation snapshot after the stream closes.
        try {
          const clone = response.clone();
          if (clone.body && typeof clone.body.getReader === 'function') {
            (async () => {
              const reader = clone.body.getReader();
              try {
                while (true) {
                  const { done } = await reader.read();
                  if (done) break;
                }
              } catch (_) {
                // The canonical snapshot sync below is the source of truth.
              } finally {
                scheduleSync('conversation-stream-complete', 250);
              }
            })();
          } else {
            clone.text()
              .catch(() => '')
              .finally(() => scheduleSync('conversation-stream-complete', 250));
          }
        } catch (_) {
          scheduleSync('conversation-post', 2000);
        }
      }

      return response;
    };
  }

  if (NativeXHR && NativeXHR.prototype) {
    const nativeOpen = NativeXHR.prototype.open;
    const nativeSend = NativeXHR.prototype.send;

    NativeXHR.prototype.open = function (method, url, ...rest) {
      this.__cwp_url = url;
      this.__cwp_method = String(method || 'GET').toUpperCase();
      return nativeOpen.call(this, method, url, ...rest);
    };

    NativeXHR.prototype.send = function (...args) {
      if (this.__cwp_method === 'GET' && isConversationDetailUrl(this.__cwp_url)) {
        this.addEventListener('load', function () {
          try {
            const data = typeof this.response === 'object' && this.responseType === 'json'
              ? this.response
              : JSON.parse(this.responseText);
            emitConversation(data, 'xhr', String(this.__cwp_url));
          } catch (_) {}
        }, { once: true });
      }
      if (this.__cwp_method === 'POST' && isConversationStreamUrl(this.__cwp_url)) {
        this.addEventListener('loadend', () => scheduleSync('conversation-xhr-complete', 250), { once: true });
      }
      return nativeSend.apply(this, args);
    };
  }

  // ChatGPT is an SPA. Existing conversations can be supplied during page
  // hydration without any observable GET request, so synchronize explicitly
  // on initial load and every client-side navigation.
  for (const name of ['pushState', 'replaceState']) {
    const nativeHistoryMethod = history[name];
    history[name] = function (...args) {
      const result = nativeHistoryMethod.apply(this, args);
      scheduleSync(`history-${name}`, 350);
      return result;
    };
  }
  window.addEventListener('popstate', () => scheduleSync('popstate', 350));
  window.addEventListener('focus', () => {
    if (Date.now() - lastSyncAt > 30_000) scheduleSync('window-focus', 350);
  });

  globalThis.__CWP_PAGE_HOOK__ = {
    version: '0.4.0',
    syncCurrentConversation
  };

  window.postMessage({ source: EVENT_SOURCE, type: 'hook-ready', observedAt: Date.now() }, '*');
  scheduleSync('initial', 600);
})();
