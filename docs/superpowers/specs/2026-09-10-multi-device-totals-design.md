# AI Usage：多设备合计

日期：2026-09-10  
状态：待你过目  
前序：[2026-09-09-ai-usage-design.md](./2026-09-09-ai-usage-design.md)、[2026-09-10-dashboard-theme-device-cost.md](./2026-09-10-dashboard-theme-device-cost.md)

本文取代前序中这些决定：Cloudflare 仅为可选副本、仪表盘即使配置了 Worker 也只读本机。其它口径不变：数据默认不出 vibecafe、Cursor 仅本机 hook、ChatGPT A 口径、`~/.ai-usage/`、托盘读 snapshot。

## 问题

四台机器（Windows、macOS、Ubuntu x64、Ubuntu ARM）各自采集。任意一台打开 AI Usage（含托盘「今日 Token」）都要看到四台合计，并仍可按设备筛选。不把数据交给 vibecafe.ai。已有 Cloudflare 账号和空 D1 库 `ai-usage`；同一账号上还有 `comments` 与 `analytics-db`，额度共用。

## 目标与非目标

**做**

- 任意设备的仪表盘默认显示全部 hostname 的合计；筛选「设备」可看单台
- 托盘「今日 Token」与仪表盘默认一致：四台合计（含 ChatGPT 开关口径）
- 用户自建 Cloudflare Worker + 已有 D1 `ai-usage`；Bearer 密钥，无 OAuth
- 增量上传 / 增量拉取，避免打满免费档 D1 写入（全账号 10 万行写/天）
- 设置页填写同步地址、密钥、本机设备名；四台贴同一份 URL + 密钥
- 离线或云端失败：托盘与仪表盘继续用上次成功的合计；页脚说明原因

**不做**

- 上传到 vibecafe.ai，或复用 `vbu_` 设备码登录
- 配对码 / 二维码 / 账号系统
- 把评论库、统计库和用量库混在同一张表
- 订阅月费按设备数相乘
- GitHub 主页徽章、公开摘要
- 本阶段仍不引入 SQLite 为仪表盘主数据（继续 `snapshot.json`）
- 安装包内置 Node

## 产品形态

未配置 `apiUrl` + `apiKey`：行为与现在相同，只显示本机。

配置之后：每次同步（30 分钟或「更新数据」）先采本机，再增量上传，再拉取其它设备，写入一份合并后的 `snapshot.json`。仪表盘、图表、托盘都只读这一份。默认不筛设备 = 合计；筛了 hostname = 那一台。

订阅月费仍按本机设置里出现过的 **source** 各计一次（现有 `costLine` 已是 `uniqueSources`），四台都有 Cursor 仍是一份月费。API 费用按合并后的 token × 本机单价。

## 架构

```text
每台设备，每 30 分钟 / 「更新数据」
  collectLocal()                    本机 parsers
  mergeSnapshotBySource(...)        仅合并本机失败 source 的旧行
  incremental ingest → Worker      只传新的/变过的桶和 session
  GET /api/usage?since=...          增量拉云端（其它设备 + 自己上次成功上传）
  merge：其它 hostname 用云端；本机 hostname 以本次 collect 为准
  丢掉 cursor-cloud
  写入 snapshot.json 与 remote.json
  托盘 / 仪表盘读 snapshot.json
```

本机是该 hostname 的权威。云端是其它设备的副本，以及本机已成功上传的历史。上传失败时：本机行仍进 snapshot，其它设备用 `remote.json` 里上次拉到的数据。

D1 读写与存储是 **Cloudflare 账号级** 配额（Workers Free：500 万行读/天、10 万行写/天、5 GB 存储；2026-09-01 起超限硬失败）。用量必须用独立库 `ai-usage`，不得写入 `comments` / `analytics-db`。当前观测：评论与统计以读为主、写入接近 0，合计采用增量后通常每天只有几百到几千次写入。

## 组件

| 部分 | 职责 |
|---|---|
| `cloudflare/` | Worker：鉴权、gzip ingest upsert、`since` 拉取、允许任意合法 source（含 `chatgpt-web`） |
| D1 `ai-usage` | 已存在的空库；只存 bucket / session 行 |
| `sidecar/dump.mjs` | 本机采集 + 增量 ingest + 拉取 + 按 hostname 合并 |
| `~/.ai-usage/state.json` | 与 vibe-usage 相同的「已上传内容哈希」，避免整表重写 |
| `~/.ai-usage/remote.json` | 上次成功拉取的云端行 + `pulledAt` / `since` 游标 |
| 设置页 | `apiUrl`、`apiKey`、`hostname`、连接状态 |
| 仪表盘 / 托盘 | 不改合计算法，只改读入的 snapshot 是否含其它设备 |

配置继续用 `~/.ai-usage/config.json`。sidecar 已把 `VIBE_USAGE_CONFIG_DIR` / `STATE_DIR` 指到该目录；`apiUrl` / `apiKey` / `hostname` 与 vibe-usage 字段同名。密钥**不要**要求 `vbu_` 前缀。

## 数据流与合并

Bucket 身份：`source|model|project|hostname|bucketStart`（与 vibe-usage `bucketKey` 一致）。

Session 身份（Worker 主键）：`source|sessionHash|hostname`。比 CLI 的 `source|sessionHash` 多 hostname，避免两台机器偶然同 hash 互相覆盖。

合并规则（每次 dump 写 snapshot 前）：

1. `local` = 本次 `collectLocal` + 本机 `mergeSnapshotBySource`（失败 source 保留本机旧行）
2. `remote` = `remote.json` 与本次 GET 按身份 upsert 后的结果
3. snapshot buckets/sessions = `remote` 中 `hostname !== 本机` 的行 ∪ `local` 全部行
4. 再 `dropCloudRows`（去掉 `cursor-cloud`）
5. 本机 hostname 在 remote 里的行**不用来覆盖** local（避免上传失败后被旧云端盖掉刚采到的数）

未配置云端：不写 remote、不请求网络，snapshot 只有 local（现有测试保持）。

`hostname` 第一次同步时若配置里没有，则写入去掉 `.local` 的系统主机名，之后稳定复用。设置页可改；改名后新数据打新名，旧名行会留在云端直到不再出现在任何设备的 local 里（第一版不做跨设备改名迁移）。两台 Ubuntu 若系统名相同，必须在设置里改成不同设备名，否则会互相覆盖。

## Cloudflare Worker

仓库内 `cloudflare/`：`wrangler.toml`（绑定 database_name `ai-usage`，`database_id` 由部署者填）、`schema.sql`、Worker 源码。不把密钥写进 git。

鉴权：`Authorization: Bearer <AUTH_TOKEN>`。未带或错误 → 401。`AUTH_TOKEN` 用 `wrangler secret`。CORS 不必为浏览器放开；sidecar 用 Node `https`。

**POST `/api/usage/ingest`**

- 与现 vibe-usage 客户端兼容：gzip JSON `{ buckets, sessions?, client? }`
- upsert buckets / sessions；`estimatedCost` 可忽略
- 不调用、不要求 `/api/usage/settings`；项目名原样保存（用户自己的库）
- 未知 source **不要 drop**（个人库，新 parser 必须进得去）
- 单次写入只处理请求体里的行，禁止「先 DELETE 该 hostname 再全量插入」

**GET `/api/usage?days=N`** 与 **GET `/api/usage?since=<ISO>`**

- 返回 `{ buckets, sessions }`，字段与 ingest 相同，供 sidecar 合并
- 首次无游标：`days` 默认 90（可分页）；成功后 sidecar 把游标写入 `remote.json`
- 之后用 `since`（该 ISO 之后 `updated_at` 有变化的行）；`since` 与 `days` 同时出现时以 `since` 为准
- 查询必须走 `bucket_start` / `updated_at` 索引，禁止全表无过滤扫描
- Worker Free 每请求 CPU 10ms：增量 `since` 为默认路径；若 90 天全量首次拉取超时，Worker 用 `limit` + `cursor` 分页，sidecar 循环直到结束

失败时 Worker 返回明确 JSON 错误（含 D1 免费档超限文案），sidecar 当本次 ingest 或 GET 失败，不阻塞写本机 snapshot。

### D1 表

```sql
CREATE TABLE buckets (
  source TEXT NOT NULL,
  model TEXT NOT NULL,
  project TEXT NOT NULL,
  hostname TEXT NOT NULL,
  bucket_start TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cached_input_tokens INTEGER NOT NULL DEFAULT 0,
  reasoning_output_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (source, model, project, hostname, bucket_start)
);
CREATE INDEX idx_buckets_start ON buckets(bucket_start);
CREATE INDEX idx_buckets_updated ON buckets(updated_at);

CREATE TABLE sessions (
  source TEXT NOT NULL,
  session_hash TEXT NOT NULL,
  hostname TEXT NOT NULL,
  project TEXT,
  first_message_at TEXT,
  last_message_at TEXT,
  duration_seconds INTEGER,
  active_seconds INTEGER,
  message_count INTEGER,
  user_message_count INTEGER,
  user_prompt_hours TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (source, session_hash, hostname)
);
CREATE INDEX idx_sessions_updated ON sessions(updated_at);
```

第一版不做按时间删除。行数按 4 设备 × 90 天 × 30 分钟桶估算为数万级，远低于 500 MB / 5 GB。

## 设置与安装

设置页新卡片「多设备同步」：

- 同步地址（Worker URL）
- 密钥（密码框，本机明文存 `config.json`，与现在 vibe-usage 本地密钥相同信任模型）
- 本机设备名（`hostname`）
- 状态：未配置 / 上次上传与拉取时间 / 失败原因
- 说明：四台填写**同一**地址和密钥；数据在你自己的 D1，不经过 vibecafe

用户安装应用后的步骤：

1. 四台都安装 AI Usage（Cursor hook、扩展按现有设置页）
2. **一次**：在已有 Cloudflare 账号部署仓库里的 Worker，绑定 D1 `ai-usage`，设置 `AUTH_TOKEN`
3. 把 Worker URL 和密钥贴进每一台的设置
4. 点「更新数据」或等 30 分钟；设备名冲突则在设置里改名

README 用中文写这四步，并写明：D1 额度与网站评论/统计共用；本应用必须用独立库 `ai-usage`。

## 错误处理

| 情况 | 行为 |
|---|---|
| 未配置 URL 或密钥 | 不访问网络；snapshot 仅本机；页脚可提示未配置云端 |
| ingest 失败（含 D1 写满） | 本机行仍写入 snapshot；其它设备用 `remote.json`；页脚「上传失败」 |
| GET 失败 | 其它设备用 `remote.json`；无 remote 则只有本机；页脚「拉取失败，合计可能不完整」 |
| 401 | 页脚「密钥无效」；不重试刷屏 |
| 本机 parser `skipped` | 与现在相同：不修剪该 source 的本机旧行 |
| 出现 `text` | 剥离后继续 |
| 两台同 hostname | 后写覆盖先写；设置页提示设备名需唯一 |

托盘在失败时**不回退成「只显示本机」**（避免数字突然变小）；用上次成功合并的 snapshot。只有从未成功拉取过、且当前 GET 失败时，合计才等于本机。

## 测试

- 合并：本机行覆盖同 hostname 的 remote；其它 hostname 保留；`cursor-cloud` 仍丢弃
- 未配置：`dumpSnapshot` 不发起 HTTP（现有断言保留），`ingested` 为 false
- 增量：第二次 dump 对未变化的桶不再 POST 那些行
- `since` 拉取：第二次只合并新行，不丢旧 remote
- ingest 失败仍写出含本机数据的 snapshot
- Worker：upsert 幂等、401、gzip 体、chatgpt-web 可写入、按 `since` 过滤
- 计费：多 hostname 的同一订阅 source 月费仍加一次；API 按合并 token 计

## 明确口径

- 合计 = 合并后 snapshot 里所有 hostname；不是再做一套服务端汇总卡片
- 托盘 = 今日、合并后、受「ChatGPT 估算计入总 Token」约束
- 云端是用户自己的 Worker + D1 `ai-usage`，不是 vibecafe
- Cursor 继续 `VIBE_USAGE_CURSOR_MODE=device`，禁止上传 `cursor-cloud` 行
- 免费档配额按账号共享；用增量，不用全量重写
