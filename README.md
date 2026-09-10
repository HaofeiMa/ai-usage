# AI Usage

本机 AI 编程工具与 ChatGPT 网页 Token 用量托盘仪表盘。数据默认留在 `~/.ai-usage/`（Windows：`%USERPROFILE%\.ai-usage`），不会上传到 [vibecafe.ai](https://vibecafe.ai)。

托盘显示**今日 Token**。打开面板可按时间、工具、设备、项目筛选。多台电脑填同一套同步地址和密钥后，任意一台看到的是合计。

## 试用前准备

- macOS Apple Silicon（本仓库当前安装包是 aarch64 `.dmg`）
- 已安装 **Node.js 20+**，终端里执行 `node -v` 能看到版本（解析用量靠系统里的 `node`，安装包不内置 Node）
- 需要 ChatGPT 网页用量时：Chrome 或 Edge

## 1. 安装桌面应用（Mac）

1. 打开 `AI Usage_0.2.0_aarch64.dmg`，把 **AI Usage** 拖进「应用程序」。
2. 安装包未公证。若提示已损坏或无法打开：右键图标选「打开」，或执行：

```bash
xattr -cr /Applications/AI\ Usage.app
```

3. 打开应用。不会弹出主窗口，菜单栏会出现今日 Token。点图标打开仪表盘。退出请用托盘菜单，关面板不会退出。
4. 第一次打开后，应用会自动：登记浏览器 Native Host、安装 Cursor 本机 hook。
5. 点「同步数据」（刷新图标）或等最多 30 分钟，确认本机编程工具用量出现。

## 2. ChatGPT 网页用量（可选）

1. 用仓库里的 `extension/` 目录，或解压 Release 里的 `ai-usage-chatgpt-extension.zip`。
2. 打开 `chrome://extensions` 或 Edge 对应页面，打开「开发者模式」。
3. 「加载已解压的扩展程序」，选该目录。
4. 先打开过一次桌面应用（上一步），再打开 [chatgpt.com](https://chatgpt.com)。只有扩展运行期间打开或同步过的会话会进入统计。

设置页里「ChatGPT 网页扩展」会显示是否已在采集。

## 3. 多设备合计

任意一台的托盘和仪表盘默认显示**全部设备合计**；筛选「设备」可看单台。Cursor 只统计本机 hook，不会拉 cursor.com 整账号账单。

### 3.1 云端（只需部署一次）

Worker 已绑到你的 D1 库 `ai-usage`。若还没部署过，在 `cloudflare/` 目录：

```bash
# 1. wrangler.toml 里 database_id 填 D1 的 ID
npx wrangler d1 execute ai-usage --file=schema.sql --remote
npx wrangler secret put AUTH_TOKEN
npx wrangler deploy
```

记下输出的地址，例如：

```text
https://ai-usage.haofeima.workers.dev
```

`AUTH_TOKEN` 是你自己设的那把密钥。不要写进 git、不要发到公开 Issue。

当前这套环境的同步地址就是上面这个 `workers.dev`。密钥以你本机设置页或 `~/.ai-usage/config.json` 里已保存的为准。

### 3.2 每台电脑都做

1. 安装并打开 AI Usage。
2. 设置 → **多设备同步**：
   - **同步地址：** Worker URL（四台相同，不要末尾斜杠也可以，有斜杠一般也能用）
   - **密钥：** 同一把 `AUTH_TOKEN`
   - **本机设备名：** 不要重复。两台 Ubuntu 如果都叫 `ubuntu`，改成例如 `ubuntu-x64` / `ubuntu-arm`
3. 点仪表盘上的同步。成功后状态为「已从云端合并其它设备」。
4. 换一台再同步，第一台再刷一次，应能在「按设备」里看到多个 hostname。

未填地址或密钥时，只显示本机，不会访问网络。上传失败时托盘仍用上次成功的合计，不会突然只剩本机。

D1 每天的读写额度与网站评论、访问统计**共用**。用量必须用独立库 `ai-usage`，且只增量上传有变化的行。

## 4. 数据在哪

| 路径 | 内容 |
| --- | --- |
| `~/.ai-usage/snapshot.json` | 仪表盘和托盘读的合并快照 |
| `~/.ai-usage/config.json` | 主题、计费、同步地址、密钥、设备名 |
| `~/.ai-usage/remote.json` | 上次从云端拉到的其它设备数据 |
| `~/.ai-usage/cursor-device.jsonl` | 本机 Cursor hook 日志 |
| `~/.ai-usage/chatgpt-web.jsonl` | ChatGPT 网页扩展写出的用量（无正文） |

## 5. 常见问题

| 现象 | 处理 |
| --- | --- |
| 菜单栏没有数字 / 刷新失败 | 确认 `node -v` ≥ 20，且 GUI 应用能找到 `node`（Homebrew 一般在 `/opt/homebrew/bin/node`） |
| 编程有数、Cursor 为空 | 打开过 Cursor 并完成一轮对话；设置页应显示已在采集本机 Cursor |
| 对话分段为空 | 扩展未加载，或还没在 chatgpt.com 打开过会话 |
| 合计没有另一台 | 那台还没填同一套地址和密钥，或还没点过同步；设备名不要撞车 |
| 提示密钥无效 | 密钥与 `wrangler secret put AUTH_TOKEN` 不一致 |
| macOS 提示已损坏 | `xattr -cr /Applications/AI\ Usage.app` 后右键打开 |

## 下载安装（Release）

以后安装包会放在 [GitHub Releases](https://github.com/HaofeiMa/ai-usage/releases)：

| 平台 | 文件 |
| --- | --- |
| macOS Apple Silicon | `.dmg`（aarch64） |
| macOS Intel | `.dmg`（x64） |
| Windows 11 | `.msi` 或 NSIS `.exe` |
| Ubuntu 22.04+ | `.deb` 或 AppImage |
| Chrome / Edge 扩展 | `ai-usage-chatgpt-extension.zip` |

Windows 可能被 SmartScreen 拦截，选择仍要运行即可。

## 设计文档

- 产品规格：[docs/superpowers/specs/2026-09-09-ai-usage-design.md](docs/superpowers/specs/2026-09-09-ai-usage-design.md)
- 多设备合计：[docs/superpowers/specs/2026-09-10-multi-device-totals-design.md](docs/superpowers/specs/2026-09-10-multi-device-totals-design.md)
- 实现计划：[docs/superpowers/plans/2026-09-10-multi-device-totals.md](docs/superpowers/plans/2026-09-10-multi-device-totals.md)

## 开发

```bash
npm install
npm test
npm run tauri dev    # 托盘 + 仪表盘（需 Rust / Xcode CLT）
npm run tauri build -- --bundles dmg
```

闲时只有托盘进程。本机数据目录：`~/.ai-usage/`（Codex 解析缓存为 `~/.ai-usage/cache`）。解析器优先读 `AI_USAGE_VIBE_USAGE_SRC`，否则依次尝试 `vendor/vibe-usage/src`、仓库旁 `../vibe-usage-chatgpt-web/src` 与 `../vibe-usage/src`。v1 不内置 Node 运行时。
