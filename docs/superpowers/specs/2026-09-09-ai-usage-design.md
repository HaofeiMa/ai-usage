# AI Usage 设计

日期：2026-09-09  
状态：待实现（本文经对话确认，实现前仍须你过目）

## 问题

不想把本机 AI 用量上传到 vibecafe.ai，但需要一个 Win11 / macOS / Ubuntu 22.04+ 都能装的托盘应用：开机自启、启动后藏到后台、占用低、状态栏能看到今日 Token，点开后有对标 vibe-cafe 桌面端的仪表盘。办公主力在 ChatGPT 网页，现有本机 parser 覆盖不到，需要把草稿插件 ChatGPT Workload Probe v0.4 收进同一套统计。

## 目标与非目标

**第一版要做**

- 跨平台桌面端 **AI Usage**（仓库/二进制 `ai-usage`）
- 本机采集编程类 agent 用量（复用本仓库 parser，安装包内置 Node sidecar）
- ChatGPT 网页用量（改现有插件，A 口径估算）
- 本机 SQLite 为仪表盘主数据；可选同步到自己的 Cloudflare Worker + D1
- 仪表盘：编程工具 / ChatGPT / 全部；开关控制估算是否计入合计与托盘

**第一版不做**

- 按公开 API 单价估算总费用，以及按订阅套餐算美元
- Codex / Claude 订阅配额（官方用量接口 / Keychain）
- 把 vibe-usage parser 用 Rust 重写
- Electron
- Firefox 插件、Claude.ai / Gemini 网页采集（jsonl 约定预留，不做采集）
- VS Code Copilot IDE（仅现有 Copilot CLI parser）
- Chrome 网上应用店上架（第一版 unpacked / 随包目录 + 说明）
- 把思考秒数折成 `reasoningOutputTokens` 并计入与其它工具的合计
- 与现有 `~/.vibe-usage` / vibecafe 账号混用同一份 state

## 产品形态

对外名称：**AI Usage**。插件：**AI Usage · ChatGPT**。

对标对象：cc-switch 的托盘/轻量模式 + vibe-usage-app 弹出仪表盘的信息架构（去掉费用卡）。官方 Windows 应用「安装包内置 Node + CLI」的分发方式，不采用其「数据默认上传 vibecafe」的后端。

## 架构

闲时只有 Tauri/Rust 托盘进程。主窗口 WebView 在关闭面板时销毁。Node sidecar 按需 spawn，跑完退出。

```text
开机 → Tauri 托盘（Rust）
         │  每 30 分钟 / 「更新数据」
         ▼
      spawn 内置 Node sidecar
         │  现有 vibe-usage parsers + chatgpt-web.jsonl
         ├─ upsert 本机 SQLite
         └─ 若已配置 apiUrl：ingest → 用户的 Cloudflare Worker → D1
         ▼
      Node 退出

点托盘 → 临时创建 WebView（读本机 SQLite）
关面板 → 销毁 WebView
```

| 部分 | 职责 | 不做 |
|---|---|---|
| Tauri 壳 | 开机启动、单实例、托盘数字、创建/销毁仪表盘、注册 Native Messaging host | 不解析各工具日志 |
| 内置 Node + parser | 与现 `sync` 相同的本机采集；新增 `chatgpt-web` | 不常驻 |
| 本机 SQLite | 托盘与仪表盘的权威数据 | 不存 prompt/回复正文 |
| Cloudflare Worker + D1 | 兼容 `/api/usage/ingest` 与 `GET /api/usage`；多设备副本；以后给 GitHub/主页 | 不跑 parser |
| Chrome/Edge 插件 | 采集 ChatGPT 网页；无正文快照；Native Messaging 写出 jsonl | 不直连 vibecafe |

数据目录：**`~/.ai-usage/`**（Windows：`%USERPROFILE%\.ai-usage`）。Sidecar 将配置/state 指到此目录，不读写 `~/.vibe-usage`。

未配置 Worker 时：本机同步与仪表盘仍可用；页脚可提示云端未配置。

## 数据模型

沿用 vibe-usage 双轨：30 分钟 token bucket + session。

### 编程工具

现有 parser 输出不变。`source` 为 `claude-code`、`codex`、`cursor` 等。Token 为各工具日志中的用量，不是估算。

### ChatGPT 网页（A 口径）

`source` 固定为 `chatgpt-web`。数字是估算，仪表盘带来源上的 `~`。

由插件写入 `~/.ai-usage/chatgpt-web.jsonl`，每条无正文，至少包含：

- `message_id`
- `conversation_id`
- `create_time`：Unix 秒（与 ChatGPT 会话 payload 一致，允许小数）
- `role`：`user` | `assistant`
- 分类布尔量：与探针 v0.4 一致（`isVisibleUser` / `isVisibleAssistant` / `isFinalReply` / `isModelStep`）
- `estimated_tokens`（对该条可见文本的估算；无正文后仍保留此数）
- `model`（可空）
- `thinking_seconds`（model step 上的 `finished_duration_sec` / `duration_sec`）
- 可选 `estimated_context_input_tokens`：仅供插件 popup，**parser 不把它计入 bucket 的 input/output**

Parser 按消息 `create_time` 聚成 30 分钟 bucket（时间窗由仪表盘再滤）。hostname 用本机配置中的稳定 hostname，不设云端哨兵。

| 字段 | 规则 |
|---|---|
| `inputTokens` | `isVisibleUser` 的 `estimated_tokens` |
| `outputTokens` | `isVisibleAssistant` 的 `estimated_tokens`（含 commentary，不含 analysis/tool） |
| `cachedInputTokens` | 0 |
| `reasoningOutputTokens` | 0 |
| `model` | 该条上的 model slug；缺失则为 `(unknown)` |
| `project` | 字面量 `chatgpt`，不用会话标题（避免工作内容进库/上云） |
| session | 一个 `conversation_id` 一条；user 与最终回复为时间事件；`durationSeconds` 用常规 first–last；`activeSeconds` **只用** model step 的 `thinking_seconds` 之和，不用回合间隔去估 |

覆盖范围：只有插件运行期间打开或同步过的会话。未打开的历史聊天不出现。这是产品限制，不是故障。

去重：同一 `conversation_id` 以最新快照为准再导出 jsonl 事件；parser 对 `(conversation_id, message_id)` last-write-wins，避免 Native Messaging 重放双计。

## 仪表盘

对标 vibe-usage-app 弹出面板，去掉费用。

**分段：** 编程工具 | ChatGPT | 全部

| 分段 | 数据 |
|---|---|
| 编程工具 | 除 `chatgpt-web` 外的全部 source |
| ChatGPT | 仅 `chatgpt-web` |
| 全部 | 两类合计；受下面开关约束 |

**开关：「ChatGPT 估算计入总 Token」**

- 只改变「全部」的卡片/图表，以及托盘上的那一个数字
- ChatGPT 分段始终显示估算，不受开关影响
- 持久化在 `~/.ai-usage/` 配置中
- 默认：**打开**

关：全部 ≈ 编程工具。开：全部 = 编程 + ChatGPT。图表在「全部 + 计入」时必须能从图例区分 `chatgpt-web` 与其它 source。

**时间范围：** 今天 / 24H / 7D / 30D / 90D / 自定义

**筛选：** 终端（hostname）/ 工具 / 模型 / 项目

**卡片（无费用）：**

| 卡片 | 算法 |
|---|---|
| 总 Token | `inputTokens + outputTokens + reasoningOutputTokens`（不含缓存读）。ChatGPT 为 A 口径可见文本估算 |
| 缓存 Token | `cachedInputTokens`（ChatGPT 为 0） |
| 活跃时长 | sessions 的 `activeSeconds` |
| 总时长 | sessions 的 `durationSeconds` |

**图：** 按小时或按日的 Token 趋势；四个分布（终端 / 工具 / 模型 / 项目）

**托盘：** macOS 菜单栏文字为「今日总 Token」；口径与当前开关一致（含缓存读，与官方菜单栏「单数字含 cache」一致，但 ChatGPT 无 cache）。Windows/Linux：图标 + tooltip。点开才出面板。

**页脚：** 上次同步时间、「更新数据」、退出。失败时保留上次成功数字，页脚说明原因。

## 插件改动（相对 v0.4）

保留：MAIN world hook、活跃分支、v0.4 消息分类、按 `create_time` 不计无时间戳节点、无持续轮询、token 不落盘。

必须改：

1. `normalize` 之后 **丢弃 `text`**，chrome.storage 与 jsonl 均无正文。
2. Native Messaging 到 `com.aiusage.chatgpt`；失败则本地排队，host 可用再刷。
3. 导出事件供 A 口径 parser 使用；上下文估算可留在 popup，不作为 ingest 的 input。
4. popup 可保留 ChatGPT 专用调试（prompts、最终回复、model steps、思考时长、可见 Token、上下文估算）。

第一版目标浏览器：Chrome 与 Edge（Chromium MV3）。安装包注册对应 Native Messaging host 清单。扩展本体不能静默安装：随 App 提供目录 + 设置页说明「加载已解压的扩展」。

## Cloudflare（可选）

Worker 实现与现 vibe-usage 客户端兼容的 ingest（gzip JSON：`buckets` / `sessions`）和 `GET /api/usage?days=`。鉴权用用户自备的 Bearer 密钥，不必 OAuth。`chatgpt-web` 必须在允许的 source 列表里，避免被当 unknown drop。

费用字段 `estimatedCost` 第一版可省略或恒为 0；客户端不展示费用卡。

多设备：在线时 Worker 可作副本；仪表盘第一版仍以本机库为准。GitHub profile / 主页脚本是后续，用 Worker 上的公开摘要（无项目名、无会话标题）。

## 安装与系统集成

| 系统 | 包 | 开机启动 | 托盘 |
|---|---|---|---|
| Windows 11 | NSIS | 当前用户 Run | 托盘图标 + tooltip |
| macOS | DMG | 登录项 | 菜单栏文字 |
| Ubuntu 22.04+ | `.deb` | XDG Autostart | AppIndicator |

启动：不显示主窗口；macOS 不以常规 Dock 应用出现（可后续再做「显示 Dock」）。单实例。关闭仪表盘 = 隐藏并销毁 WebView，不是退出；退出只从托盘菜单。

安装程序写入 Native Messaging host，指向 App 内的小型 host 可执行文件：从 stdin 读 JSON，追加到 `chatgpt-web.jsonl`（行级追加、忽略坏 JSON、不截断文件）。

## 错误处理

- 单 parser 失败：`skipped`，不修剪该 source 的旧增量状态（与现 sync 语义一致）。
- Sidecar 整体失败：页脚报错；托盘用上一次成功数字。
- 无插件 / host 未注册：ChatGPT 分段空态 + 设置说明；编程工具不受影响。
- jsonl 坏行：跳过。
- Worker 不可达：本机 upsert 仍成功；下次再试 ingest；不阻塞仪表盘。
- WebView 崩溃：只拆窗口，托盘继续。
- 任何路径上若出现 `text` 字段：剥掉后继续，不当作同步失败。

## 测试

自动：

- 现有 parser 测试随 sidecar 所带代码一起跑
- `chatgpt-web` parser：夹具 jsonl → A 口径 bucket；即使行内有 `estimated_context_input_tokens` 也不计入 Token
- 有 `text` 的输入被剥掉且不入库
- `(conversation_id, message_id)` 重复行 last-write-wins
- 插件 core：分类回归 + 去正文 + A 口径聚合
- Native host：合法行追加、坏行忽略、并发追加不截断
- 纯函数：三分段 + 开关对合计的影响

人工（非 CI）：Win11 / macOS / Ubuntu 22.04 上安装、开机启动、托盘、打开/关闭仪表盘后内存回到托盘水平、插件加载与写 jsonl。

## 实现落点

- **新仓库** `ai-usage`：Tauri 2 壳、仪表盘前端、sidecar 打包、installer、Native host、改过的插件
- **本仓库** `@vibe-cafe/vibe-usage`：新增 `chatgpt-web` parser 与 jsonl 约定，供 sidecar 引用或 vendoring。不在本仓库做 Tauri 壳，以免和 CLI 发布混在一起

第一版实现顺序建议（计划阶段再拆任务）：parser 约定与测试 → 插件去正文与 jsonl → Native host → Tauri 托盘与本机 SQLite 仪表盘 → 可选 Worker → 三端打包。

## 明确的产品口径（防歧义）

- ChatGPT Token：**A** = 时间窗内新产生的可见 user + 可见 assistant 文本估算。不是累计上下文（曾讨论的 B）。
- 「工作量很大但字很少」：体现在 **活跃时长**（thinking 秒），不编造 reasoning Token。
- 「计入总 Token」开关：只作用于分段「全部」和托盘，默认开。
- 费用：第一版无此栏。
- 数据默认不出本机；Cloudflare 是用户自己的可选副本，不是 vibecafe。
