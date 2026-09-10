# AI Usage

本机 AI 编程工具与 ChatGPT 网页 Token 用量托盘仪表盘。数据默认留在 `~/.ai-usage/`（Windows：`%USERPROFILE%\.ai-usage`），不会上传到 [vibecafe.ai](https://vibecafe.ai)。

## 下载安装

安装包在 [GitHub Releases](https://github.com/HaofeiMa/ai-usage/releases) 发布：

| 平台 | 文件 |
| --- | --- |
| macOS Apple Silicon | `.dmg`（aarch64） |
| macOS Intel | `.dmg`（x64） |
| Windows 11 | `.msi` 或 NSIS `.exe` |
| Ubuntu 22.04+ | `.deb` 或 AppImage |
| Chrome / Edge 扩展 | `ai-usage-chatgpt-extension.zip` |

安装包未做 Apple / Microsoft 公证。macOS 若提示已损坏，可右键打开，或执行 `xattr -cr /Applications/AI\ Usage.app`。Windows 可能被 SmartScreen 拦截，选择仍要运行即可。

解析本机用量需要系统已安装 **Node.js 20+**，并保证 `node` 在 PATH 中。

### 浏览器扩展

1. 解压 `ai-usage-chatgpt-extension.zip`
2. 打开 Chrome / Edge 的 `chrome://extensions`，打开「开发者模式」
3. 「加载已解压的扩展程序」，选解压后的目录
4. 先打开一次桌面应用，让它登记 Native Messaging host

也可以直接加载仓库里的 `extension/` 目录。

## 设计文档

- 产品规格：[docs/superpowers/specs/2026-09-09-ai-usage-design.md](docs/superpowers/specs/2026-09-09-ai-usage-design.md)
- 实现计划：[docs/superpowers/plans/2026-09-09-ai-usage.md](docs/superpowers/plans/2026-09-09-ai-usage.md)

## 开发

```bash
npm install
npm test
npm run tauri dev    # 托盘 + 仪表盘（需 Rust / Xcode CLT）
npm run tauri build  # 本地打包
```

闲时只有托盘进程。关闭仪表盘会销毁 WebView，不会退出应用。退出请用托盘菜单。

本机数据目录：`~/.ai-usage/`（Codex 解析缓存为 `~/.ai-usage/cache`）。托盘每 30 分钟（以及点「更新数据」时）会启动系统 `node sidecar/dump.mjs` 写入 `snapshot.json`。解析器优先读 `AI_USAGE_VIBE_USAGE_SRC`，否则依次尝试 `vendor/vibe-usage/src`、仓库旁 `../vibe-usage-chatgpt-web/src` 与 `../vibe-usage/src`。v1 不内置 Node 运行时。
