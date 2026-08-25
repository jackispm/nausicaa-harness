# Nausicaa

Nausicaa 是一个面向长程任务的轻量 Agent harness。它以一条专注执行的 Main lane 为主线，并让低频辅助 lane 在旁路独立观察、提出建议；辅助线不会复制完整对话，也不会阻塞主线。

这是早期可运行版本，接口与命令行参数尚未稳定。

## 当前能力

- 基于 [`pi-ai`](https://github.com/earendil-works/pi/tree/main/packages/ai) 接入模型与 OpenRouter，不重复实现 provider 调度。
- Main 运行有界 tool loop，首版工具仅包含工作区内的 `list_files`、`read_file` 和 `write_file`。
- JSONL Ledger 与内容寻址 Store 保存事实和大对象，支持 checkpoint 与 Run 恢复。
- Teto 辅助线读取固定大小的观察帧，低频检查目标偏离、意图缺失和更优方法。
- Advice 通过持久 Inbox 在 Main 的自然边界进入上下文，可明确接受、延后或拒绝。

当前没有 TUI、shell 工具、通用 graph DSL 或插件市场。

## 本地使用

要求 Node.js `>=22.19`。

```bash
npm install
npm run build
npm link

export OPENROUTER_API_KEY="..."
nausicaa --model openrouter:openai/gpt-5-mini "查看这个项目如何安装"
```

也可设置 `NAUSICAA_MODEL`，省略每次调用的 `--model`。运行状态默认写入工作区的 `.nausicaa/`；使用 `nausicaa --resume <run-id>` 从已提交边界继续。

`npm run dev -- <参数>` 通过 `tsx` 直接运行 TypeScript 源码，只是开发调试入口。构建后的产品入口是 `nausicaa`；`npm start -- <参数>` 则直接运行 `dist/cli.js`。

## 开发门禁

```bash
npm run typecheck     # 严格 TypeScript 检查
npm test              # 离线 unit、protocol 与 recovery 测试
npm run test:smoke    # 构建并验证真实 CLI 产物
npm run check         # 执行完整本地门禁
```

真实 OpenRouter 测试不会默认运行。只有同时设置 `NAUSICAA_LIVE_TESTS=1`、`OPENROUTER_API_KEY`、`NAUSICAA_EVAL_MODEL` 和正数 `NAUSICAA_EVAL_BUDGET_USD` 时，才会发起一次显式的最小请求。

## 设计原则

- **KISS**：小内核、少概念、窄接口。
- **DIY**：自研差异化 runtime，复用成熟的通用能力。
- **Model-forward**：不把弱模型时期的临时补偿固化进内核。
- **Evidence-driven**：能力与性能主张必须通过可复现实验验证。
- **Ledger-driven**：持久事实属于账本，可丢弃状态由事实重建。

项目仍处于实验阶段，请勿依赖未发布的 API。
