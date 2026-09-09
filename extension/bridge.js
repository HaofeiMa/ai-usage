(() => {
  'use strict';

  if (globalThis.__CWP_BRIDGE_INSTALLED__) return;
  globalThis.__CWP_BRIDGE_INSTALLED__ = true;
  const SOURCE = 'chatgpt-workload-probe';
  const core = globalThis.ChatGPTProbeCore;
  let queue = Promise.resolve();

  function updateStorage(mutator) {
    queue = queue.then(async () => {
      const state = await chrome.storage.local.get(['snapshots', 'debug']);
      const next = mutator(state) || state;
      await chrome.storage.local.set(next);
    }).catch(err => {
      console.debug('[ChatGPT Workload Probe] storage update failed', err);
    });
    return queue;
  }

  window.addEventListener('message', event => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== SOURCE) return;

    if (data.type === 'hook-ready') {
      updateStorage(state => ({
        debug: { ...(state.debug || {}), hookReadyAt: data.observedAt, lastPage: location.href }
      }));
      return;
    }

    if (data.type === 'sync-status') {
      updateStorage(state => ({
        debug: {
          ...(state.debug || {}),
          lastSyncAt: data.observedAt,
          lastSyncStatus: data.status,
          lastSyncReason: data.reason || null,
          lastSyncConversationId: data.conversationId || null,
          lastSyncHttpStatus: data.httpStatus || null,
          lastSyncError: data.error || null,
          lastPage: location.href
        }
      }));
      return;
    }

    if (data.type !== 'conversation' || !data.payload) return;
    const snapshot = core.normalizeConversation(data.payload, data.observedAt);
    if (!snapshot) return;
    const profile = core.profileConversation(snapshot);

    updateStorage(state => {
      const snapshots = state.snapshots || {};
      snapshots[snapshot.id] = snapshot;
      return {
        snapshots,
        debug: {
          ...(state.debug || {}),
          lastObservedAt: data.observedAt,
          lastConversationId: snapshot.id,
          lastConversationTitle: snapshot.title,
          lastTransport: data.transport,
          lastMessageCount: snapshot.messages.length,
          lastConversationProfile: profile,
          lastPage: location.href
        }
      };
    });
  });
})();
