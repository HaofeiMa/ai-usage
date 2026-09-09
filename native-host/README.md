# Native Messaging host (`com.aiusage.chatgpt`)

Chrome/Edge Native Messaging host for the **AI Usage · ChatGPT** extension. Reads length-prefixed JSON from stdin and appends one jsonl record per line to `~/.ai-usage/chatgpt-web.jsonl`.

## Install (manual, dev)

1. Copy `com.aiusage.chatgpt.json` into the browser native-messaging hosts directory.
2. Replace `HOST_PATH` with the absolute path to `host.mjs` (or a packaged Node wrapper).
3. Replace `chrome-extension://REPLACE_WITH_EXTENSION_ID/` in `allowed_origins` with your unpacked extension id (from `chrome://extensions`).
4. Reload the extension after changing origins.

Platform host manifest locations are documented in [Chrome Native Messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging).

## Log path overrides

| Variable | Precedence |
|---|---|
| `AI_USAGE_CHATGPT_WEB_LOG` | 1 |
| `VIBE_USAGE_CHATGPT_WEB_LOG` | 2 |
| default `~/.ai-usage/chatgpt-web.jsonl` | 3 |

## Protocol

Each stdin message: 4-byte **native-endian** length + UTF-8 JSON. Payload is either an array of records or `{ "records": [...] }`. Malformed frames are ignored. Any `text` field on a record is stripped before append.
