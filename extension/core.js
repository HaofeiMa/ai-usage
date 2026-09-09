(function (global) {
  'use strict';

  const SNAPSHOT_SCHEMA_VERSION = 2;

  function extractConversationId(value) {
    try {
      const url = new URL(String(value), 'https://chatgpt.com');
      const match = url.pathname.match(/\/c\/([0-9a-f-]{20,})(?:\/|$)/i);
      return match ? match[1] : null;
    } catch (_) {
      return null;
    }
  }

  function extractText(content) {
    if (!content) return '';
    if (Array.isArray(content.parts)) {
      return content.parts.map(part => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object') {
          if (typeof part.text === 'string') return part.text;
          if (typeof part.content === 'string') return part.content;
        }
        return '';
      }).filter(Boolean).join('\n');
    }
    if (typeof content.text === 'string') return content.text;
    if (typeof content.content === 'string') return content.content;
    return '';
  }

  function estimateTokens(text) {
    if (!text) return 0;
    const s = String(text).trim();
    if (!s) return 0;
    const cjk = (s.match(/[\u3400-\u9FFF\uF900-\uFAFF\u3040-\u30FF\uAC00-\uD7AF]/g) || []).length;
    const latinWords = (s.replace(/[\u3400-\u9FFF\uF900-\uFAFF\u3040-\u30FF\uAC00-\uD7AF]/g, ' ').match(/[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)?/g) || []).length;
    const punctuation = (s.match(/[^\s\w\u3400-\u9FFF\uF900-\uFAFF\u3040-\u30FF\uAC00-\uD7AF]/g) || []).length;
    const otherNonSpace = s.replace(/[\sA-Za-z0-9\u3400-\u9FFF\uF900-\uFAFF\u3040-\u30FF\uAC00-\uD7AF]/g, '').length;
    return Math.max(1, Math.round(cjk * 1.05 + latinWords * 1.28 + punctuation * 0.35 + otherNonSpace * 0.2));
  }

  function activeBranch(payload) {
    const mapping = payload && payload.mapping;
    let cursor = payload && payload.current_node;
    if (!mapping || !cursor || !mapping[cursor]) return [];
    const result = [];
    const seen = new Set();
    while (cursor && mapping[cursor] && !seen.has(cursor)) {
      seen.add(cursor);
      result.push(mapping[cursor]);
      cursor = mapping[cursor].parent;
    }
    return result.reverse();
  }

  function finiteTimestamp(...values) {
    for (const value of values) {
      if (value === null || value === undefined || value === '') continue;
      const n = Number(value);
      if (Number.isFinite(n) && n > 0) return n;
    }
    return null;
  }

  function getThinkingSeconds(metadata) {
    if (!metadata || typeof metadata !== 'object') return 0;
    const candidates = [metadata.finished_duration_sec, metadata.duration_sec];
    for (const value of candidates) {
      const n = Number(value);
      if (Number.isFinite(n) && n > 0) return n;
    }
    return 0;
  }

  function getModel(metadata) {
    if (!metadata || typeof metadata !== 'object') return null;
    return metadata.model_slug || metadata.resolved_model_slug || metadata.default_model_slug || metadata.model || null;
  }

  function classifyMessage(msg, role, text, metadata, model) {
    const recipient = typeof msg.recipient === 'string' ? msg.recipient : 'all';
    const channel = typeof msg.channel === 'string' ? msg.channel : null;
    const weight = Number.isFinite(Number(msg.weight)) ? Number(msg.weight) : 1;
    const isVisuallyHidden = metadata.is_visually_hidden_from_conversation === true;
    const eligible = weight !== 0 && !isVisuallyHidden;
    const proseChannel = channel === null || channel === 'final' || channel === 'commentary';

    const isVisibleUser = role === 'user' && eligible;
    const isVisibleAssistant = role === 'assistant' && eligible && recipient === 'all' && proseChannel && channel !== 'analysis';
    const isFinalReply = role === 'assistant' && eligible && recipient === 'all' && (
      channel === 'final' ||
      (channel === null && msg.end_turn === true && Boolean(String(text || '').trim()))
    );
    const isModelStep = role === 'assistant' && eligible && Boolean(model);

    return {
      recipient,
      channel,
      endTurn: msg.end_turn === true,
      weight,
      isVisuallyHidden,
      messageType: metadata.message_type || null,
      isVisibleUser,
      isVisibleAssistant,
      isFinalReply,
      isModelStep
    };
  }

  function stripMessageText(message) {
    if (!message || typeof message !== 'object') return message;
    if (!('text' in message)) return message;
    const { text: _text, ...rest } = message;
    return rest;
  }

  function sanitizeSnapshot(snapshot) {
    if (!snapshot || typeof snapshot !== 'object') return snapshot;
    if (!Array.isArray(snapshot.messages)) return snapshot;
    return {
      ...snapshot,
      messages: snapshot.messages.map(stripMessageText)
    };
  }

  function sanitizeSnapshots(snapshots) {
    const out = {};
    for (const [id, snapshot] of Object.entries(snapshots || {})) {
      out[id] = sanitizeSnapshot(snapshot);
    }
    return out;
  }

  function normalizeConversation(payload, observedAtMs) {
    if (!payload || typeof payload !== 'object') return null;
    const nowSec = (observedAtMs || Date.now()) / 1000;
    const messages = [];
    for (const entry of activeBranch(payload)) {
      const msg = entry && entry.message;
      if (!msg || !msg.author) continue;
      const role = msg.author.role;
      if (role !== 'user' && role !== 'assistant') continue;
      const text = extractText(msg.content);
      const metadata = msg.metadata || {};
      const model = role === 'assistant' ? getModel(metadata) : null;
      const classification = classifyMessage(msg, role, text, metadata, model);
      messages.push({
        id: msg.id || entry.id || `${role}-${messages.length}`,
        role,
        createTime: finiteTimestamp(msg.create_time),
        updateTime: finiteTimestamp(msg.update_time),
        estimatedTokens: estimateTokens(text),
        thinkingSeconds: role === 'assistant' ? getThinkingSeconds(metadata) : 0,
        model,
        contentType: msg.content && msg.content.content_type || null,
        ...classification
      });
    }
    const id = payload.id || payload.conversation_id || null;
    if (!id) return null;
    return sanitizeSnapshot({
      schemaVersion: SNAPSHOT_SCHEMA_VERSION,
      id,
      title: payload.title || 'Untitled conversation',
      createTime: finiteTimestamp(payload.create_time, ...messages.map(m => m.createTime)) || nowSec,
      updatedAt: finiteTimestamp(payload.update_time, ...messages.slice().reverse().map(m => m.updateTime || m.createTime)) || nowSec,
      currentNode: payload.current_node || null,
      messages,
      observedAt: nowSec
    });
  }

  function increment(map, key) {
    const normalized = key === null || key === undefined || key === '' ? '(none)' : String(key);
    map[normalized] = (map[normalized] || 0) + 1;
  }

  function profileConversation(snapshot) {
    const profile = {
      schemaVersion: snapshot && snapshot.schemaVersion || null,
      messages: 0,
      prompts: 0,
      visibleAssistantMessages: 0,
      finalReplies: 0,
      modelSteps: 0,
      assistantChannels: {},
      assistantRecipients: {},
      assistantContentTypes: {}
    };
    if (!snapshot || !Array.isArray(snapshot.messages)) return profile;
    profile.messages = snapshot.messages.length;
    for (const m of snapshot.messages) {
      if (m.isVisibleUser) profile.prompts += 1;
      if (m.isVisibleAssistant) profile.visibleAssistantMessages += 1;
      if (m.isFinalReply) profile.finalReplies += 1;
      if (m.isModelStep) profile.modelSteps += 1;
      if (m.role === 'assistant') {
        increment(profile.assistantChannels, m.channel);
        increment(profile.assistantRecipients, m.recipient);
        increment(profile.assistantContentTypes, m.contentType);
      }
    }
    return profile;
  }

  function aggregateForRange(snapshots, startSec, endSec) {
    const stats = {
      prompts: 0,
      assistantReplies: 0,
      modelSteps: 0,
      conversations: 0,
      thinkingTurns: 0,
      thinkingSeconds: 0,
      visibleUserTokens: 0,
      visibleAssistantTokens: 0,
      estimatedContextInputTokens: 0,
      replyModels: {},
      stepModels: {},
      conversationsDetail: [],
      legacySnapshotsSkipped: 0
    };
    for (const snapshot of Object.values(snapshots || {})) {
      if (!snapshot || snapshot.schemaVersion !== SNAPSHOT_SCHEMA_VERSION || !Array.isArray(snapshot.messages)) {
        if (snapshot) stats.legacySnapshotsSkipped += 1;
        continue;
      }
      const inRange = snapshot.messages.filter(m => {
        const t = finiteTimestamp(m.createTime);
        return t !== null && t >= startSec && t < endSec && (m.isVisibleUser || m.isFinalReply || m.isModelStep);
      });
      if (!inRange.length) continue;
      stats.conversations += 1;
      let cumulativeVisible = 0;
      let convPrompts = 0;
      let convReplies = 0;
      let convSteps = 0;
      let convThinking = 0;
      let convTokens = 0;

      for (const m of snapshot.messages) {
        const t = finiteTimestamp(m.createTime);
        const tok = Number(m.estimatedTokens) || 0;
        const isInRange = t !== null && t >= startSec && t < endSec;

        // Context is sampled only at a user-facing final answer boundary.
        // Internal analysis/tool nodes are deliberately not treated as extra replies.
        if (m.isFinalReply && isInRange) {
          stats.estimatedContextInputTokens += cumulativeVisible;
          stats.assistantReplies += 1;
          convReplies += 1;
          if (m.model) increment(stats.replyModels, m.model);
        }

        if (m.isModelStep && isInRange) {
          stats.modelSteps += 1;
          convSteps += 1;
          const thinking = Number(m.thinkingSeconds) || 0;
          if (thinking > 0) {
            stats.thinkingTurns += 1;
            stats.thinkingSeconds += thinking;
            convThinking += thinking;
          }
          if (m.model) increment(stats.stepModels, m.model);
        }

        if (m.isVisibleUser && isInRange) {
          stats.prompts += 1;
          convPrompts += 1;
          stats.visibleUserTokens += tok;
          convTokens += tok;
        }

        if (m.isVisibleAssistant && isInRange) {
          stats.visibleAssistantTokens += tok;
          convTokens += tok;
        }

        if (m.isVisibleUser || m.isVisibleAssistant) cumulativeVisible += tok;
      }

      stats.conversationsDetail.push({
        id: snapshot.id,
        title: snapshot.title,
        prompts: convPrompts,
        replies: convReplies,
        modelSteps: convSteps,
        thinkingSeconds: convThinking,
        visibleTokens: convTokens,
        updatedAt: snapshot.updatedAt
      });
    }
    stats.conversationsDetail.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    return stats;
  }

  function recordsFromSnapshot(snapshot) {
    const cleaned = sanitizeSnapshot(snapshot);
    if (!cleaned || !Array.isArray(cleaned.messages)) return [];
    const conversationId = cleaned.id;
    let cumulativeVisible = 0;
    const records = [];
    for (const m of cleaned.messages) {
      const createTime = finiteTimestamp(m.createTime, m.create_time);
      if (createTime === null) continue;
      const tok = Number(m.estimatedTokens) || 0;
      const record = {
        message_id: m.id,
        conversation_id: conversationId,
        create_time: createTime,
        role: m.role,
        isVisibleUser: Boolean(m.isVisibleUser),
        isVisibleAssistant: Boolean(m.isVisibleAssistant),
        isFinalReply: Boolean(m.isFinalReply),
        isModelStep: Boolean(m.isModelStep),
        estimated_tokens: tok,
        model: m.model ?? null,
        thinking_seconds: Number(m.thinkingSeconds) || 0
      };
      if (m.isFinalReply) {
        record.estimated_context_input_tokens = cumulativeVisible;
      }
      if (m.isVisibleUser || m.isVisibleAssistant) cumulativeVisible += tok;
      records.push(record);
    }
    return records;
  }

  const api = {
    SNAPSHOT_SCHEMA_VERSION,
    extractConversationId,
    extractText,
    estimateTokens,
    activeBranch,
    finiteTimestamp,
    getThinkingSeconds,
    getModel,
    normalizeConversation,
    sanitizeSnapshot,
    sanitizeSnapshots,
    profileConversation,
    aggregateForRange,
    recordsFromSnapshot
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.ChatGPTProbeCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
