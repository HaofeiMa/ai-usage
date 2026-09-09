# Native Messaging host (`com.aiusage.chatgpt`)

Chrome/Edge Native Messaging host for the **AI Usage · ChatGPT** extension. Reads length-prefixed JSON from stdin and appends one jsonl record per line to `~/.ai-usage/chatgpt-web.jsonl`.

`host.mjs` starts with `#!/usr/bin/env node` and should be executable (`chmod +x`). Chrome will not launch a non-executable host.

This repo does **not** write into your browser NativeMessagingHosts directory; copy the manifest yourself (installer / Task 8 will automate this later).

## Install (manual, dev)

1. Copy `com.aiusage.chatgpt.json` into the browser NativeMessagingHosts directory (filename must stay `com.aiusage.chatgpt.json`).
2. Set `path` to the absolute path of `host.mjs` (the executable host script).
3. Replace `chrome-extension://REPLACE_WITH_EXTENSION_ID/` in `allowed_origins` with your unpacked extension id (from `chrome://extensions`).
4. Reload the extension after changing origins.

### Manifest locations

| Browser | Directory / key |
|---|---|
| macOS Chrome | `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/` |
| macOS Edge | `~/Library/Application Support/Microsoft Edge/NativeMessagingHosts/` |
| Linux Chrome | `~/.config/google-chrome/NativeMessagingHosts/` |
| Linux Chromium | `~/.config/chromium/NativeMessagingHosts/` |
| Windows Chrome | Registry `HKCU\Software\Google\Chrome\NativeMessagingHosts\com.aiusage.chatgpt` (default value = manifest path) |

Also see [Chrome Native Messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging).

## Log path overrides

| Variable | Precedence |
|---|---|
| `AI_USAGE_CHATGPT_WEB_LOG` | 1 |
| `VIBE_USAGE_CHATGPT_WEB_LOG` | 2 |
| default `~/.ai-usage/chatgpt-web.jsonl` | 3 |

## Protocol

Each stdin message: 4-byte **native-endian** length + UTF-8 JSON. Payload is either an array of records or `{ "records": [...] }`. Malformed frames are ignored. Any `text` field on a record is stripped before append.
