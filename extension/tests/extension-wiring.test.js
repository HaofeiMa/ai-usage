const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = name => fs.readFileSync(path.join(root, name), 'utf8');

test('manifest includes self-healing active-tab injection permissions', () => {
  const manifest = JSON.parse(read('manifest.json'));
  assert.equal(manifest.name, 'AI Usage · ChatGPT');
  assert.equal(manifest.version, '0.5.0');
  assert.ok(typeof manifest.key === 'string' && manifest.key.startsWith('MIIB'));
  assert.ok(manifest.permissions.includes('storage'));
  assert.ok(manifest.permissions.includes('activeTab'));
  assert.ok(manifest.permissions.includes('scripting'));
  assert.ok(manifest.permissions.includes('nativeMessaging'));
  assert.equal(manifest.background.service_worker, 'background.js');
  assert.ok(manifest.host_permissions.includes('https://chatgpt.com/*'));
  assert.deepEqual(manifest.icons, {
    '16': 'icons/16.png',
    '32': 'icons/32.png',
    '48': 'icons/48.png',
    '128': 'icons/128.png',
  });
  assert.deepEqual(manifest.action.default_icon, {
    '16': 'icons/16.png',
    '32': 'icons/32.png',
  });
  for (const file of Object.values(manifest.icons)) {
    assert.ok(fs.existsSync(path.join(root, file)), file);
  }
  assert.match(read('popup.html'), /icons\/128\.png/);
  assert.equal(manifest.content_scripts[0].world, 'ISOLATED');
  assert.equal(manifest.content_scripts[1].world, 'MAIN');
});

test('popup actively injects bridge before main-world hook and records failures', () => {
  const src = read('popup.js');
  const isolated = src.indexOf("world: 'ISOLATED'");
  const main = src.indexOf("world: 'MAIN'");
  assert.ok(isolated >= 0);
  assert.ok(main > isolated);
  assert.match(src, /injectionStatus: 'error'/);
  assert.match(src, /injectionError:/);
});

test('bridge and page hook are idempotent across repeated popup opens', () => {
  assert.match(read('bridge.js'), /__CWP_BRIDGE_INSTALLED__/);
  assert.match(read('page-hook.js'), /__CWP_PAGE_HOOK__/);
  assert.match(read('page-hook.js'), /popup-reinject/);
});

test('bridge forwards jsonl records to background native host queue', () => {
  const bridge = read('bridge.js');
  const background = read('background.js');
  assert.match(bridge, /recordsFromSnapshot/);
  assert.match(bridge, /type: 'native-records'/);
  assert.match(background, /HOST_NAME = 'com\.aiusage\.chatgpt'/);
  assert.match(background, /connectNative\(HOST_NAME\)/);
  assert.match(background, /queue\.push\(records\)/);
  assert.match(background, /flushQueue/);
});

test('v0.4 popup exposes final replies and model steps separately', () => {
  const manifest = JSON.parse(read('manifest.json'));
  assert.equal(manifest.name, 'AI Usage · ChatGPT');
  assert.equal(manifest.version, '0.5.0');
  const html = read('popup.html');
  const popup = read('popup.js');
  assert.match(html, /Final replies/);
  assert.match(html, /Model steps/);
  assert.match(popup, /stats\.modelSteps/);
  assert.match(popup, /stats\.replyModels/);
  assert.match(popup, /stats\.stepModels/);
  assert.match(read('bridge.js'), /profileConversation/);
  assert.match(read('bridge.js'), /sanitizeSnapshot/);
  assert.doesNotMatch(popup, /stats\.models/);
});
