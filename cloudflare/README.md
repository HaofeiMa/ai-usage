# AI Usage Cloudflare Worker

绑定独立 D1 库 **`ai-usage`**。不要写进 `comments` 或 `analytics-db`。D1 读写额度是整个 Cloudflare 账号共用的。

当前 `wrangler.toml` 已填入库 `52f64127-626d-4b9e-b23a-8c39377f196c`。已部署地址：

```text
https://ai-usage.haofeima.workers.dev
```

密钥用 `wrangler secret`，不要写进本文件。

## 部署（只需一次）

在本目录执行。需已 `npx wrangler login`。

```bash
npx wrangler d1 execute ai-usage --file=schema.sql --remote
npx wrangler secret put AUTH_TOKEN
npx wrangler deploy
```

`secret put` 会提示你输入密钥。四台电脑的应用设置里填**同一把**。

应用设置：

- 同步地址：上面的 `https://ai-usage.haofeima.workers.dev`
- 密钥：你 put 进去的那串
- 设备名：每台唯一
