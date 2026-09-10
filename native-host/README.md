# Native Messaging host (`com.aiusage.chatgpt`)

Chrome/Edge Native Messaging host for the **AI Usage · ChatGPT** extension. Reads length-prefixed JSON from stdin and appends one jsonl record per line to `~/.ai-usage/chatgpt-web.jsonl`.

AI Usage 启动时会自动：

1. 把 `host.mjs` 复制到 `~/.ai-usage/native-host.mjs`（shebang 写成当前 Node 绝对路径）
2. 写入 Chrome / Edge / Brave / Arc 的 NativeMessagingHosts 清单
3. `allowed_origins` 使用扩展清单里固定的 `key`（ID：`mkcbknlcbjgbbabclannkpdeaigfjodl`）

你只需在浏览器里「加载已解压的扩展」一次。不要改 JSON。

## Log path overrides

| Variable | Precedence |
|---|---|
| `AI_USAGE_CHATGPT_WEB_LOG` | 1 |
| `VIBE_USAGE_CHATGPT_WEB_LOG` | 2 |
| default `~/.ai-usage/chatgpt-web.jsonl` | 3 |

## Protocol

Each stdin message: 4-byte **native-endian** length + UTF-8 JSON. Payload is either an array of records or `{ "records": [...] }`. Malformed frames are ignored. Any `text` field on a record is stripped before append.
