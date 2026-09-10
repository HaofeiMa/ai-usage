# Dashboard theme / device / cost Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Light/dark dashboard, device-only Cursor, 编程/对话/全部 + cost row, dedicated settings, app icon.

**Architecture:** Keep snapshot.json. Force Cursor device mode in sidecar, strip `cursor-cloud`. Frontend three-row chrome + settings page. Billing is config-driven pure functions.

**Tech Stack:** Existing Tauri 2 + Vite/vanilla TS, vitest, Node sidecar.

**Spec:** `docs/superpowers/specs/2026-09-10-dashboard-theme-device-cost.md`

## Global Constraints

- Product AI Usage; data `~/.ai-usage/`; never `~/.vibe-usage`
- 编程 = all sources except `chatgpt-web` (includes `codex`); 对话 = `chatgpt-web` only
- Cursor: `VIBE_USAGE_CURSOR_MODE=device`; log `~/.ai-usage/cursor-device.jsonl`; drop `cursor-cloud`; no cursor.com
- Toggle includeChatgptInTotal default on; only 全部 + tray + 全部 consumption
- Subscription monthly fee is not multiplied by tokens; API uses input+output+reasoning excluding cache
- Rename 终端 → 设备

## File map

- `src/lib/usage.ts` — dropCloud, labels stay coding/chatgpt/all ids
- `src/lib/labels.ts` — source/project display names
- `src/lib/billing.ts` — consumption A
- `src/lib/theme.ts` — resolveTheme
- `sidecar/dump.mjs` — device env + drop cloud rows
- `vibe-usage-chatgpt-web` cursor.js — device parse path
- `src/app.ts`, `src/styles.css` — UI
- `src-tauri/src/lib.rs` + `usage.rs` — open folder, skip cloud in tray
- `sidecar/cursor-device-hook.mjs` — writes ai-usage jsonl
- `src-tauri/icons/` — icon

User asked to execute immediately (inline).

---

### Task 1: Labels, drop cloud, keep view ids

TDD usage/labels. `filterBuckets` unchanged except callers drop cloud first. `dropCloudRows(items)` filters `hostname === 'cursor-cloud'`. `sourceLabel`, `projectLabel`.

### Task 2: Billing

`summarizeCost({ buckets, view, includeChatgpt, billing, currency })` → `{ subscription, api, unpriced, currency }`.

### Task 3: Dump + Cursor device parser

applyAiUsageEnv sets cursor mode+log. dropCloudRows after merge. Port device log parser into worktree cursor.js. Copy hook to sidecar with default log under AI_USAGE_HOME.

### Task 4: Dashboard UI + settings + theme

Three header rows, settings page, light/dark CSS, 设备, tool labels, cost row.

### Task 5: Icon + open extension folder command
