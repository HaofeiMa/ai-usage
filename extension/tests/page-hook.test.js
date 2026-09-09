const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const core = require('../core.js');

function flush() {
  return new Promise(resolve => setImmediate(resolve));
}

test('page hook actively syncs a preloaded project conversation without persisting auth token', async () => {
  const id = '6a9f844f-1c18-83ee-ab7e-595523f1348d';
  const posted = [];
  const requests = [];
  const payload = {
    id,
    title: 'Current chat',
    current_node: 'a1',
    mapping: {
      root: { id:'root', parent:null, message:{ author:{role:'system'}, content:{parts:['']} } },
      u1: { id:'u1', parent:'root', message:{ id:'u1', author:{role:'user'}, create_time:10, content:{parts:['hello']}, metadata:{} } },
      a1: { id:'a1', parent:'u1', message:{ id:'a1', author:{role:'assistant'}, create_time:11, content:{parts:['hi']}, metadata:{finished_duration_sec:3} } }
    }
  };

  const fakeWindow = {
    location: { href: `https://chatgpt.com/g/g-p-project/c/${id}`, pathname: `/g/g-p-project/c/${id}` },
    postMessage(message) { posted.push(message); },
    addEventListener() {},
    XMLHttpRequest: null,
    fetch: async (url, init = {}) => {
      requests.push({ url: String(url), init });
      if (String(url) === '/api/auth/session') {
        return { ok:true, status:200, json:async () => ({ accessToken:'never-store-this-token' }) };
      }
      if (String(url) === `/backend-api/conversation/${id}`) {
        return { ok:true, status:200, url:`https://chatgpt.com/backend-api/conversation/${id}`, json:async () => payload };
      }
      throw new Error(`unexpected request ${url}`);
    }
  };

  const context = {
    window: fakeWindow,
    location: fakeWindow.location,
    history: { pushState() {}, replaceState() {} },
    URL,
    globalThis: null,
    setTimeout(fn) { Promise.resolve().then(fn); return 1; },
    clearTimeout() {},
    Date,
    console
  };
  context.globalThis = context;
  context.ChatGPTProbeCore = core;
  fakeWindow.ChatGPTProbeCore = core;

  vm.createContext(context);
  vm.runInContext(fs.readFileSync(require.resolve('../page-hook.js'), 'utf8'), context);
  await flush();
  await flush();
  await flush();

  assert.ok(requests.some(r => r.url === '/api/auth/session'));
  const snapshotRequest = requests.find(r => r.url === `/backend-api/conversation/${id}`);
  assert.ok(snapshotRequest);
  assert.equal(snapshotRequest.init.method, 'GET');
  assert.equal(snapshotRequest.init.headers.authorization, 'Bearer never-store-this-token');

  const event = posted.find(m => m.type === 'conversation' && m.transport === 'active-sync');
  assert.ok(event);
  assert.equal(event.payload.id, id);

  const debugLike = JSON.stringify(posted.filter(m => m.type === 'sync-status'));
  assert.equal(debugLike.includes('never-store-this-token'), false);
});
