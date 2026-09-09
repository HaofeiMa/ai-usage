const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../core.js');

function node(id, parent, role, text, time, metadata = {}) {
  return [id, {
    id,
    parent,
    children: [],
    message: {
      id: `m-${id}`,
      author: { role },
      create_time: time,
      content: { content_type: 'text', parts: [text] },
      metadata
    }
  }];
}

test('extracts only active branch in chronological order', () => {
  const mapping = Object.fromEntries([
    node('root', null, 'system', '', 1),
    node('u1', 'root', 'user', 'hello', 2),
    node('a1', 'u1', 'assistant', 'old answer', 3),
    node('u2', 'a1', 'user', 'old branch', 4),
    node('a2', 'u1', 'assistant', 'new answer', 5, { finished_duration_sec: 12.5 }),
  ]);
  const out = core.normalizeConversation({ id: 'c1', title: 'T', current_node: 'a2', mapping }, 1000);
  assert.deepEqual(out.messages.map(m => m.role), ['user', 'assistant']);
  for (const m of out.messages) assert.equal('text' in m, false);
  assert.ok(out.messages[0].estimatedTokens >= 1);
  assert.ok(out.messages[1].estimatedTokens >= 1);
  assert.equal(out.messages[0].isVisibleUser, true);
  assert.equal(out.messages[1].isVisibleAssistant, true);
  assert.equal(out.messages[1].thinkingSeconds, 12.5);
});

test('token estimator is deterministic and positive for English and Chinese', () => {
  assert.equal(core.estimateTokens(''), 0);
  assert.ok(core.estimateTokens('hello world') >= 2);
  assert.ok(core.estimateTokens('你好，世界') >= 4);
});

test('daily aggregation counts prompts, replies, conversations and context', () => {
  const dayStart = Date.UTC(2026, 8, 8) / 1000;
  const snapshots = {
    c1: {
      id: 'c1', schemaVersion: 2, title: 'A', updatedAt: dayStart + 200,
      messages: [
        { id:'u1', role:'user', createTime:dayStart+10, estimatedTokens:2, thinkingSeconds:0, model:null, isVisibleUser:true, isVisibleAssistant:false, isFinalReply:false, isModelStep:false },
        { id:'a1', role:'assistant', createTime:dayStart+20, estimatedTokens:2, thinkingSeconds:5, model:'gpt-test', isVisibleUser:false, isVisibleAssistant:true, isFinalReply:true, isModelStep:true },
        { id:'u2', role:'user', createTime:dayStart+30, estimatedTokens:1, thinkingSeconds:0, model:null, isVisibleUser:true, isVisibleAssistant:false, isFinalReply:false, isModelStep:false },
        { id:'a2', role:'assistant', createTime:dayStart+40, estimatedTokens:1, thinkingSeconds:7, model:'gpt-test', isVisibleUser:false, isVisibleAssistant:true, isFinalReply:true, isModelStep:true },
      ]
    }
  };
  const stats = core.aggregateForRange(snapshots, dayStart, dayStart + 86400);
  assert.equal(stats.prompts, 2);
  assert.equal(stats.assistantReplies, 2);
  assert.equal(stats.conversations, 1);
  assert.equal(stats.thinkingTurns, 2);
  assert.equal(stats.thinkingSeconds, 12);
  assert.equal(stats.visibleUserTokens, 3);
  assert.equal(stats.visibleAssistantTokens, 3);
  assert.ok(stats.estimatedContextInputTokens >= 5);
});

test('extracts conversation id from standard and project ChatGPT URLs', () => {
  const id = '6a9f844f-1c18-83ee-ab7e-595523f1348d';
  assert.equal(core.extractConversationId(`https://chatgpt.com/c/${id}`), id);
  assert.equal(core.extractConversationId(`https://chatgpt.com/g/g-p-abc123/c/${id}`), id);
  assert.equal(core.extractConversationId('https://chatgpt.com/'), null);
});

test('classifies ChatGPT 2026 assistant nodes without treating internal steps as replies', () => {
  const mapping = Object.fromEntries([
    node('root2', null, 'system', '', 1),
    ['u10', {
      id: 'u10', parent: 'root2', children: [], message: {
        id: 'm-u10', author: { role: 'user' }, create_time: 10,
        content: { content_type: 'text', parts: ['question'] },
        metadata: {}, recipient: 'all', channel: null, end_turn: null, weight: 1
      }
    }],
    ['a-analysis', {
      id: 'a-analysis', parent: 'u10', children: [], message: {
        id: 'm-a-analysis', author: { role: 'assistant' }, create_time: 11,
        content: { content_type: 'text', parts: ['hidden reasoning'] },
        metadata: { model_slug: 'gpt-5-6-thinking', finished_duration_sec: 5 },
        recipient: 'all', channel: 'analysis', end_turn: false, weight: 1
      }
    }],
    ['a-tool', {
      id: 'a-tool', parent: 'a-analysis', children: [], message: {
        id: 'm-a-tool', author: { role: 'assistant' }, create_time: 12,
        content: { content_type: 'text', parts: ['tool args'] },
        metadata: { model_slug: 'gpt-5-6-thinking', finished_duration_sec: 2 },
        recipient: 'web', channel: 'analysis', end_turn: false, weight: 1
      }
    }],
    ['a-commentary', {
      id: 'a-commentary', parent: 'a-tool', children: [], message: {
        id: 'm-a-commentary', author: { role: 'assistant' }, create_time: 13,
        content: { content_type: 'text', parts: ['visible update'] },
        metadata: { model_slug: 'gpt-5.6-sol-wm', finished_duration_sec: 3 },
        recipient: 'all', channel: 'commentary', end_turn: false, weight: 1
      }
    }],
    ['a-final', {
      id: 'a-final', parent: 'a-commentary', children: [], message: {
        id: 'm-a-final', author: { role: 'assistant' }, create_time: 14,
        content: { content_type: 'text', parts: ['final answer'] },
        metadata: { model_slug: 'gpt-5.6-sol-wm', finished_duration_sec: 4 },
        recipient: 'all', channel: 'final', end_turn: true, weight: 1
      }
    }]
  ]);
  const out = core.normalizeConversation({ id: 'c-class', title: 'C', current_node: 'a-final', mapping }, 15000);
  assert.equal(out.schemaVersion, 2);
  const byId = Object.fromEntries(out.messages.map(m => [m.id, m]));
  assert.equal(byId['m-a-analysis'].isFinalReply, false);
  assert.equal(byId['m-a-analysis'].isVisibleAssistant, false);
  assert.equal(byId['m-a-tool'].isVisibleAssistant, false);
  assert.equal(byId['m-a-commentary'].isVisibleAssistant, true);
  assert.equal(byId['m-a-commentary'].isFinalReply, false);
  assert.equal(byId['m-a-final'].isFinalReply, true);
  assert.equal(byId['m-a-final'].isVisibleAssistant, true);
  assert.equal(out.messages.filter(m => m.isModelStep).length, 4);
});

test('aggregation separates final replies from model steps and excludes internal text from visible tokens', () => {
  const dayStart = Date.UTC(2026, 8, 8) / 1000;
  const snapshot = {
    id: 'c-new', schemaVersion: 2, title: 'New', updatedAt: dayStart + 100,
    messages: [
      { id:'u', role:'user', createTime:dayStart+1, estimatedTokens:10, thinkingSeconds:0, model:null, isVisibleUser:true, isVisibleAssistant:false, isFinalReply:false, isModelStep:false },
      { id:'an', role:'assistant', createTime:dayStart+2, estimatedTokens:100, thinkingSeconds:5, model:'think', isVisibleUser:false, isVisibleAssistant:false, isFinalReply:false, isModelStep:true },
      { id:'tool', role:'assistant', createTime:dayStart+3, estimatedTokens:50, thinkingSeconds:2, model:'think', isVisibleUser:false, isVisibleAssistant:false, isFinalReply:false, isModelStep:true },
      { id:'com', role:'assistant', createTime:dayStart+4, estimatedTokens:7, thinkingSeconds:3, model:'sol', isVisibleUser:false, isVisibleAssistant:true, isFinalReply:false, isModelStep:true },
      { id:'fin', role:'assistant', createTime:dayStart+5, estimatedTokens:20, thinkingSeconds:4, model:'sol', isVisibleUser:false, isVisibleAssistant:true, isFinalReply:true, isModelStep:true },
    ]
  };
  const stats = core.aggregateForRange({c: snapshot}, dayStart, dayStart + 86400);
  assert.equal(stats.prompts, 1);
  assert.equal(stats.assistantReplies, 1);
  assert.equal(stats.modelSteps, 4);
  assert.equal(stats.visibleUserTokens, 10);
  assert.equal(stats.visibleAssistantTokens, 27);
  assert.equal(stats.thinkingSeconds, 14);
  assert.deepEqual(stats.replyModels, { sol: 1 });
  assert.deepEqual(stats.stepModels, { think: 2, sol: 2 });
  assert.equal(stats.estimatedContextInputTokens, 17);
});

test('aggregation skips legacy snapshots that lack message classification schema', () => {
  const dayStart = Date.UTC(2026, 8, 8) / 1000;
  const legacy = {
    id: 'legacy', title: 'Legacy', updatedAt: dayStart + 10,
    messages: [{ id:'a', role:'assistant', createTime:dayStart+1, estimatedTokens:99, thinkingSeconds:1, model:'x' }]
  };
  const stats = core.aggregateForRange({legacy}, dayStart, dayStart + 86400);
  assert.equal(stats.conversations, 0);
  assert.equal(stats.assistantReplies, 0);
  assert.equal(stats.modelSteps, 0);
});

test('old long conversation contributes historical context once without inflating today activity', () => {
  const dayStart = Date.UTC(2026, 8, 8) / 1000;
  const yesterday = dayStart - 3600;
  const oldMessages = [];
  for (let i = 0; i < 50; i += 1) {
    oldMessages.push({
      id:`old-u-${i}`, role:'user', createTime:yesterday-i*10, estimatedTokens:100,
      thinkingSeconds:0, model:null, isVisibleUser:true, isVisibleAssistant:false,
      isFinalReply:false, isModelStep:false
    });
    oldMessages.push({
      id:`old-a-${i}`, role:'assistant', createTime:yesterday-i*10+1, estimatedTokens:100,
      thinkingSeconds:0, model:'old-model', isVisibleUser:false, isVisibleAssistant:true,
      isFinalReply:true, isModelStep:true
    });
  }
  const snapshot = {
    id:'long-old', schemaVersion:2, title:'Long old chat', updatedAt:dayStart+20,
    messages: [
      ...oldMessages,
      { id:'today-u', role:'user', createTime:dayStart+10, estimatedTokens:10, thinkingSeconds:0, model:null, isVisibleUser:true, isVisibleAssistant:false, isFinalReply:false, isModelStep:false },
      { id:'today-analysis-1', role:'assistant', createTime:dayStart+11, estimatedTokens:500, thinkingSeconds:8, model:'think', isVisibleUser:false, isVisibleAssistant:false, isFinalReply:false, isModelStep:true },
      { id:'today-analysis-2', role:'assistant', createTime:dayStart+12, estimatedTokens:500, thinkingSeconds:9, model:'think', isVisibleUser:false, isVisibleAssistant:false, isFinalReply:false, isModelStep:true },
      { id:'today-final', role:'assistant', createTime:dayStart+13, estimatedTokens:20, thinkingSeconds:3, model:'sol', isVisibleUser:false, isVisibleAssistant:true, isFinalReply:true, isModelStep:true }
    ]
  };

  const stats = core.aggregateForRange({ longOld: snapshot }, dayStart, dayStart + 86400);
  assert.equal(stats.prompts, 1);
  assert.equal(stats.assistantReplies, 1);
  assert.equal(stats.modelSteps, 3);
  assert.equal(stats.visibleUserTokens, 10);
  assert.equal(stats.visibleAssistantTokens, 20);
  assert.equal(stats.estimatedContextInputTokens, 10010);
});

test('missing message timestamps are not reassigned to observation day', () => {
  const dayStart = Date.UTC(2026, 8, 8) / 1000;
  const mapping = {
    root: { id:'root', parent:null, message:{ author:{role:'system'}, content:{parts:['']} } },
    oldUser: { id:'oldUser', parent:'root', message:{ id:'old-user', author:{role:'user'}, content:{parts:['old undated prompt']}, metadata:{} } },
    todayUser: { id:'todayUser', parent:'oldUser', message:{ id:'today-user', author:{role:'user'}, create_time:dayStart+10, content:{parts:['today prompt']}, metadata:{} } },
    final: { id:'final', parent:'todayUser', message:{ id:'today-final', author:{role:'assistant'}, create_time:dayStart+20, content:{parts:['today answer']}, metadata:{model_slug:'sol'}, recipient:'all', channel:'final', end_turn:true, weight:1 } }
  };
  const snapshot = core.normalizeConversation({ id:'undated', title:'Undated history', current_node:'final', mapping }, (dayStart+100)*1000);
  const undated = snapshot.messages.find(m => m.id === 'old-user');
  assert.equal(undated.createTime, null);

  const stats = core.aggregateForRange({ undated: snapshot }, dayStart, dayStart + 86400);
  assert.equal(stats.prompts, 1);
  assert.equal(stats.assistantReplies, 1);
});

test('normalizeConversation never persists message text on snapshots', () => {
  const mapping = Object.fromEntries([
    node('root3', null, 'system', '', 1),
    node('u1', 'root3', 'user', 'secret prompt body', 2),
    node('a1', 'u1', 'assistant', 'secret reply body', 3, { model_slug: 'gpt-test', finished_duration_sec: 1 }),
  ]);
  const out = core.normalizeConversation({ id: 'c-no-text', title: 'T', current_node: 'a1', mapping }, 1000);
  for (const m of out.messages) {
    assert.equal('text' in m, false);
    assert.ok(m.estimatedTokens >= 1);
  }
});

test('recordsFromSnapshot emits parser jsonl fields without text', () => {
  const dayStart = Date.UTC(2026, 8, 8) / 1000;
  const mapping = Object.fromEntries([
    node('root4', null, 'system', '', 1),
    node('u1', 'root4', 'user', 'hello', dayStart + 10),
    ['a1', {
      id: 'a1', parent: 'root4', children: [], message: {
        id: 'm-a1', author: { role: 'assistant' }, create_time: dayStart + 20,
        content: { content_type: 'text', parts: ['hi there'] },
        metadata: { model_slug: 'gpt-test', finished_duration_sec: 5 },
        recipient: 'all', channel: 'final', end_turn: true, weight: 1
      }
    }]
  ]);
  mapping.u1.parent = 'root4';
  mapping.a1.parent = 'u1';
  const snapshot = core.normalizeConversation({ id: 'c-rec', title: 'R', current_node: 'a1', mapping }, 1000);
  const records = core.recordsFromSnapshot(snapshot);
  assert.equal(records.length, 2);
  for (const r of records) {
    assert.equal('text' in r, false);
    assert.equal(r.conversation_id, 'c-rec');
    assert.ok(r.message_id);
    assert.ok(['user', 'assistant'].includes(r.role));
    assert.equal(typeof r.isVisibleUser, 'boolean');
    assert.equal(typeof r.isVisibleAssistant, 'boolean');
    assert.equal(typeof r.isFinalReply, 'boolean');
    assert.equal(typeof r.isModelStep, 'boolean');
    assert.ok(Number.isFinite(r.estimated_tokens));
    assert.ok('model' in r);
    assert.ok(Number.isFinite(r.thinking_seconds));
  }
  const user = records.find(r => r.role === 'user');
  const assistant = records.find(r => r.role === 'assistant');
  assert.equal(user.create_time, dayStart + 10);
  assert.equal(assistant.create_time, dayStart + 20);
  assert.equal(assistant.isFinalReply, true);
  assert.equal(assistant.thinking_seconds, 5);
  assert.equal(assistant.estimated_context_input_tokens, user.estimated_tokens);
});

test('message update_time alone does not turn old undated content into today activity', () => {
  const dayStart = Date.UTC(2026, 8, 8) / 1000;
  const mapping = {
    root: { id:'root', parent:null, message:{ author:{role:'system'}, content:{parts:['']} } },
    oldUser: { id:'oldUser', parent:'root', message:{ id:'old-user-updated', author:{role:'user'}, update_time:dayStart+5, content:{parts:['old prompt with only update time']}, metadata:{} } },
    todayUser: { id:'todayUser', parent:'oldUser', message:{ id:'today-user-2', author:{role:'user'}, create_time:dayStart+10, content:{parts:['today prompt']}, metadata:{} } },
    final: { id:'final', parent:'todayUser', message:{ id:'today-final-2', author:{role:'assistant'}, create_time:dayStart+20, content:{parts:['today answer']}, metadata:{model_slug:'sol'}, recipient:'all', channel:'final', end_turn:true, weight:1 } }
  };
  const snapshot = core.normalizeConversation({ id:'updated-only', title:'Updated only', current_node:'final', mapping }, (dayStart+100)*1000);
  const old = snapshot.messages.find(m => m.id === 'old-user-updated');
  assert.equal(old.createTime, null);
  assert.equal(old.updateTime, dayStart+5);
  const stats = core.aggregateForRange({ snapshot }, dayStart, dayStart + 86400);
  assert.equal(stats.prompts, 1);
});
