# AI Usage

AI Usage 是一款跨平台桌面托盘应用，用于在本机汇总 AI 编程工具与 ChatGPT 网页的 Token 用量，并提供对标 vibe-cafe 桌面端的仪表盘（不含费用卡）。

**数据默认留在本机**，存放在 `~/.ai-usage/`（Windows：`%USERPROFILE%\.ai-usage`）。本应用**不会**把用量上传到 [vibecafe.ai](https://vibecafe.ai)，也不与 `~/.vibe-usage` 或 vibecafe 账号混用。可选的 Cloudflare Worker 同步由用户自行配置，属于后续能力。

## 目标平台

- Windows 11
- macOS
- Ubuntu 22.04+

## ChatGPT 网页扩展

ChatGPT 网页用量通过 **AI Usage · ChatGPT** 浏览器扩展采集（Chrome / Edge，MV3）。扩展通过 Native Messaging 将估算用量写入 `~/.ai-usage/chatgpt-web.jsonl`。

第一版以「加载已解压的扩展」方式安装，不依赖 Chrome 网上应用店。扩展目录为仓库内 `extension/`；桌面应用设置页会显示绝对路径与加载步骤。

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

闲时只有托盘进程。关闭仪表盘会销毁 WebView，不会退出应用。退出请用托盘菜单或仪表盘页脚「退出」。

本机数据目录：`~/.ai-usage/`。托盘每 30 分钟（以及点「更新数据」时）会 spawn 系统 `node sidecar/dump.mjs` 写入 `snapshot.json` 后退出。v1 使用 PATH / Homebrew 上的 Node，不内置 Node 运行时。
