(() => {
  'use strict';

  const HOST_NAME = 'com.aiusage.chatgpt';
  let port = null;
  const queue = [];

  function connectNativePort() {
    if (port) return port;
    try {
      port = chrome.runtime.connectNative(HOST_NAME);
      port.onDisconnect.addListener(() => {
        port = null;
      });
    } catch (err) {
      port = null;
      console.debug('[AI Usage · ChatGPT] native host connect failed', err);
    }
    return port;
  }

  function flushQueue() {
    const activePort = connectNativePort();
    if (!activePort) return;

    while (queue.length > 0) {
      const batch = queue[0];
      try {
        activePort.postMessage(batch);
        queue.shift();
      } catch (err) {
        port = null;
        console.debug('[AI Usage · ChatGPT] native host post failed', err);
        return;
      }
    }
  }

  function enqueueRecords(records) {
    if (!Array.isArray(records) || records.length === 0) return;
    queue.push(records);
    flushQueue();
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || message.type !== 'native-records') return;
    if (!Array.isArray(message.records)) {
      sendResponse({ ok: false, error: 'records must be an array' });
      return;
    }
    enqueueRecords(message.records);
    sendResponse({ ok: true, queued: queue.length });
  });
})();
