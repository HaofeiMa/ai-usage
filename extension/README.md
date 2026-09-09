# AI Usage · ChatGPT

Chrome/Edge extension for the [AI Usage](https://github.com/vibe-cafe/ai-usage) desktop app. Collects ChatGPT web usage metrics locally on `chatgpt.com` without persisting prompt or reply bodies.

## v0.4 metric definitions

**Daily activity (timestamp-gated)**
- **Prompts**: visible user messages created today on the active conversation branch.
- **Final replies**: user-facing assistant answers created today. Internal analysis, tool calls, and progress/commentary nodes are not counted as separate replies.
- **Model steps**: assistant model nodes created today that expose model metadata. This intentionally includes internal reasoning/tool-oriented steps as a task-complexity signal.
- **Conversations**: conversations with at least one qualifying activity node today.
- **Thinking**: sum of `finished_duration_sec` / `duration_sec` on qualifying model steps when ChatGPT exposes those fields.

**Estimated tokens**
- visible user text created today
- visible assistant text created today (including user-visible commentary plus final answers)
- visible context processed at final-reply boundaries

The context estimate deliberately behaves differently from daily visible text: if you continue a long old conversation today, historical visible context can contribute because the new answer may reuse it. That historical context is sampled **once per final reply**, not once per analysis/tool/model step.

Token values are estimates, not OpenAI billing or usage numbers. Hidden system/developer context, tool payloads, memory, cached tokens, compaction details, and hidden reasoning tokens cannot be measured reliably from ChatGPT Web.

## Important timestamp behavior

v0.4 no longer assigns the observation time (or `update_time`) to a user/assistant node that lacks `create_time`. An undated historical node is therefore not silently turned into "today" activity. It can still contribute to the visible-context estimate if it is on the active branch before a final reply today.

## Collection design

ChatGPT may hydrate an existing conversation without issuing a browser-visible detail GET after the extension starts. The extension therefore uses two read-only paths:

1. passive observation of ChatGPT's own conversation-detail requests;
2. an event-driven same-origin snapshot sync for the currently open `/c/{conversation_id}` route.

A snapshot is refreshed after SPA navigation and after a ChatGPT conversation stream finishes. There is no continuous polling. The short-lived ChatGPT access token used for the read-only snapshot request stays in page memory and is never persisted.

Snapshots are keyed by conversation ID and replaced with the latest copy, so opening or syncing the same conversation repeatedly does not double-count it. Only the active `current_node -> parent` branch is analyzed, so abandoned regenerate/edit branches are ignored.

## Install / update

1. Unzip the folder.
2. Open `chrome://extensions`.
3. Enable **Developer mode**.
4. Load the unpacked `chatgpt-workload-probe` folder, or replace the existing folder and click **Reload**.
5. Refresh `https://chatgpt.com/`.
6. Open or continue a conversation, then open the extension popup.

### Updating from v0.3

v0.3 snapshots did not preserve enough channel/recipient metadata to distinguish final replies from internal model steps after the fact. v0.4 therefore uses a new snapshot schema. If old local snapshots remain, the popup will tell you how many need refresh. Reopen those conversations once and they will be replaced with v0.4 snapshots.

## Privacy

There is no third-party telemetry. Conversation snapshots are stored only in `chrome.storage.local` in your browser profile. No cookies or access tokens are included in Debug output.
