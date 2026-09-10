# AI Usage 仪表盘：主题、本机设备、费用栏

日期：2026-09-10  
状态：待你过目  
前序：[2026-09-09-ai-usage-design.md](./2026-09-09-ai-usage-design.md)

本文取代前序中这些决定：分段「编程工具 | ChatGPT」、筛选「终端」、第一版无费用、Cursor 可用账号 CSV（`cursor-cloud`）。架构（Tauri 托盘、按需 Node、`~/.ai-usage/`、ChatGPT A 口径、无 Electron）不变。仪表盘第一版仍读 `snapshot.json`（SQLite 仍后置）。

## 问题

仪表盘只有暗色、把 Cursor 账号账单显示成另一台「设备」、Codex / ChatGPT 网页在工具列表里不明显、设置和费用挤在主界面。需要本机口径、三栏顶栏、独立设置、亮/暗色和图标。

## 目标与非目标

**做**

- 亮色 / 暗色 / 跟随系统
- 只用**当前设备**用量；Cursor 不用 cursor.com 账号 CSV
- 分布图「终端」改为「设备」；丢掉 `cursor-cloud`
- 工具显示名：Claude Code、Cursor、ChatGPT (Codex)、ChatGPT 网页等
- 有项目名就按项目归类
- 顶栏三栏：使用方式、时间、消费
- 独立设置页（同一窗口）
- 按工具付费：订阅 / API / 免费；第三栏按规则 A 展示
- 应用图标（托盘 / Dock / 窗口）
- 视觉层级整理

**不做**

- cursor.com 账号账单、把 `cursor-cloud` 合并进本机总量
- 订阅按 token 再乘单价
- 会话标题当 ChatGPT 网页的 project
- 独立设置原生窗口、React 重写
- Cloudflare、安装包内置 Node、SQLite（仍属原计划 Task 8）
- 思考秒数折成 reasoning Token

## 使用方式（第一栏）

| 分段 | 数据 |
|---|---|
| 编程 | 除 `chatgpt-web` 外的全部 source（含 `codex`） |
| 对话 | 仅 `chatgpt-web` |
| 全部 | 编程 + 对话；受「ChatGPT 估算计入总 Token」约束 |

开关语义与前序相同：只影响「全部」的卡片、趋势、消费合计、以及托盘数字。对话页始终显示估算。默认打开。

## Cursor：仅本机

sidecar 采集时：

- 固定 `VIBE_USAGE_CURSOR_MODE=device`（忽略账号模式）
- `VIBE_USAGE_CURSOR_DEVICE_LOG` 指到 `~/.ai-usage/cursor-device.jsonl`（不要默认写 `~/.vibe-usage`）
- **不请求** cursor.com，不生成 `hostname: cursor-cloud`
- 写入 snapshot 前丢掉任何已有的 `cursor-cloud` 行（不把它们改打成本机名）
- 本机 Cursor 行的 hostname = 稳定设备名（与其它工具相同，如 `Huffies-Mac-mini`）

若 jsonl 不存在：Cursor 为空，设置页提示安装设备 hook。缺少 device parser 时，从 vibe-usage 的 device 实现移植进 sidecar 所用的 parser 树，而不是退回 CSV。

## 设备、工具、项目

**设备：** 筛选和分布标题用「设备」。只展示本机稳定 hostname。多设备以后若出现多 hostname，仍按 hostname 分，但不会再出现 `cursor-cloud`。

**工具显示名（source → 界面）：**

| source | 显示 |
|---|---|
| `claude-code` | Claude Code |
| `cursor` | Cursor |
| `codex` | ChatGPT (Codex) |
| `chatgpt-web` | ChatGPT 网页 |
| `copilot-cli` | GitHub Copilot CLI |
| 其它 | 沿用现有 TOOLS 名称 |

没有 `cc-switch` source；经 cc-switch 走的 Claude Code 仍是 `claude-code`。

**项目：** 用 bucket/session 的 `project`。空、`unknown`、缺失 → 「未命名」。ChatGPT 网页仍为字面量 `chatgpt`。Cursor / Codex / Claude Code 已有项目路径的，按项目名归类。

## 顶栏

三行，不要把开关、时间、方式挤成一排。

1. **使用方式：** 全部 | 编程 | 对话。另有「设置」进入设置页。
2. **时间：** 今天 | 24H | 7D | 30D | 90D（本地时区；不做自定义）。
3. **消费：** 当前方式和时间范围内：

| 行 | 订阅 | API |
|---|---|---|
| 编程 | 本栏出现过、且设为订阅的工具的月费之和 | 本范围内编程 API 工具的 token（input+output+reasoning，不含缓存读）× 单价 |
| 对话 | 同上（通常是 ChatGPT 网页若标成订阅） | 对话 API 估算；开关关闭时「全部」不含对话 API |
| 全部 | 两栏相加（受开关约束） | 同上 |

- 订阅：**不**按这段 token 折算，只展示你填的月费。
- API：手填单价优先；否则用内置价目（过期则偏，界面注明「估算」）。未定价 → 「未定价」，不计入合计。
- 免费：0。
- 货币：设置里选 USD 或 CNY，金额按该货币显示。默认 USD。
- 不做第四张费用大卡；Token 四卡仍在内容区。

## 设置页

同一 WebView 内的整页，不是主界面折叠块。可返回仪表盘。

- ChatGPT 扩展：若 `~/.ai-usage/chatgpt-web.jsonl` 存在且至少有一行合法 JSON，显示已在采集；否则视为未装好，按钮用系统文件管理器打开 `extension/`（开发时为仓库目录，打包后为资源目录）。
- 开机自动启动（写入 `config.json` 的 `autostart`）。
- ChatGPT 估算计入总 Token。
- 主题：跟随系统 / 亮色 / 暗色。默认跟随系统。
- 每个已知工具一行付费：订阅（月费）/ API（自动价目或手填「每百万 token」或等价单价）/ 免费。
- Cursor 无本机 jsonl 时：如何安装设备 hook（把 hook 写到 `~/.ai-usage/cursor-device.jsonl`）。

## 主题与视觉

- `html[data-theme=light|dark]` + CSS 变量。跟随系统时用 `prefers-color-scheme`。
- 亮色：浅底、深字、细分割线；暗色：保持现有深色层次但提高对比。
- 顶栏、四张 Token 卡、趋势、四个分布（设备 / 工具 / 模型 / 项目）层级分开。ChatGPT 网页数字带 `~`。
- 托盘菜单栏文字仍是今日 Token（含 cache，受开关约束）；不随主题换一套托盘图标。

## 图标

一枚简洁「AU」或用量符号，浅底深字 + 暗色可用同一图形。生成后写入 `src-tauri/icons/`（png / icns / ico）。不要用默认 Tauri 占位图。

## 配置（`~/.ai-usage/config.json`）

在现有字段上增加，例如：

```json
{
  "theme": "system",
  "includeChatgptInTotal": true,
  "autostart": true,
  "currency": "USD",
  "billing": {
    "cursor": { "kind": "subscription", "monthly": 20 },
    "claude-code": { "kind": "subscription", "monthly": 20 },
    "codex": { "kind": "subscription", "monthly": 20 },
    "chatgpt-web": { "kind": "subscription", "monthly": 20 }
  }
}
```

`kind`：`subscription` | `api` | `free`。API 可含 `inputPerMillion` / `outputPerMillion`；缺省则查内置表。

## 错误处理

- 无 Cursor jsonl：编程里没有 Cursor，不是同步失败。
- 扩展未装：对话空态 + 设置里的打开文件夹。
- 价目缺失：该工具 API 行显示未定价，合计忽略它。
- 丢弃 `cursor-cloud` 不算同步失败。

## 测试

- `filterBuckets` / 托盘：编程含 `codex`、不含 `chatgpt-web`；对话仅网页；`cursor-cloud` 行不进入任何合计。
- dump：device 模式不写 `cursor-cloud`；旧 snapshot 合并时剔除该 hostname。
- 消费：订阅月费不随 token 变；API 随时间窗 token 变；开关关闭时全部不含对话 API。
- 主题：`data-theme` 与 config 一致（纯函数或 DOM 测即可）。

## 明确口径

- Cursor：本机 hook，不是账号账单。
- 编程 vs 对话：Codex 在编程；对话只有 ChatGPT 网页。
- 消费 A：订阅 = 填的月费；API = 范围内心 token × 单价；免费 = 0。
