# Nausicaa

Nausicaa 是一个面向长程任务的轻量 Agent harness。它以一条专注执行的 Main lane 为主线，并让低频辅助 lane 在旁路独立观察、提出建议；辅助线不会复制完整对话，也不会阻塞主线。

这是早期可运行版本，接口与命令行参数尚未稳定。

## 当前能力

- 基于 [`pi-ai`](https://github.com/earendil-works/pi/tree/main/packages/ai) 接入模型与 OpenRouter，不重复实现 provider 调度。
- Main 运行有界 tool loop，默认只读工作区内的 `list_files`、`read_file`；写入必须显式使用 `--allow-write`。
- `.env`、`.git`、`.nausicaa`、私钥和常见凭据路径始终受保护，即使开启写入也不能访问。
- JSONL Ledger 与内容寻址 Store 保存事实和大对象，支持 checkpoint 与 Run 恢复。
- Teto 辅助线读取固定大小的观察帧，低频检查目标偏离、意图缺失和更优方法。
- Advice 通过持久 Inbox 在 Main 的自然边界进入上下文，可明确接受、延后或拒绝。
- TTY 默认进入持续 Session：一个 Run 可包含多个 Turn，支持 steering、取消、恢复和 `--continue`。
- 运行中按 Enter 注入 steering，按 Alt+Enter 排队 follow-up；输入和 ACK 都写入 Ledger。
- `pi-tui` 只负责终端 surface；SessionController、Ledger 和模型执行保持独立，未来可接桌面 UI。

当前没有 shell 工具、通用 graph DSL 或插件市场。

`write_file` 只在已有目录中写文件，不负责创建目录。工作区边界会拒绝绝对路径、`..`、已有符号链接和受保护路径；当前威胁模型不覆盖同一系统账号下的其他进程并发替换文件系统节点。

## 本地使用

要求 Node.js `>=22.19`。

```bash
npm install
npm run build
npm link

export OPENROUTER_API_KEY="..."
export NAUSICAA_MODEL="openrouter:openai/gpt-5-mini"

# 在项目目录进入持续会话；不带消息会等待输入
nausicaa

# 启动后直接提交第一条消息
nausicaa "查看这个项目如何安装"

# 脚本或 CI 使用 one-shot，不进入交互界面
nausicaa -p "查看这个项目如何安装"

# 恢复或附着当前项目最近的 Run
nausicaa --resume <run-id>
nausicaa --continue

# 需要修改工作区时显式打开写入
nausicaa --allow-write --model openrouter:openai/gpt-5-mini "修复这个项目"
```

也可设置 `NAUSICAA_MODEL`，省略每次调用的 `--model`。运行状态默认写入工作区的 `.nausicaa/`；使用 `nausicaa --resume <run-id>` 从已提交边界继续。若恢复时发现结果未知的工具操作，CLI 会打印 operation ID 和显式结算命令；确认其应按失败处理后再执行该命令，运行时不会自动重放副作用。

`npm run dev -- <参数>` 通过 `tsx` 直接运行 TypeScript 源码，是开发调试入口，不是产品交互模型。构建后的产品入口是 `nausicaa`；`npm start -- <参数>` 直接运行 `dist/cli.js`。因此别人项目看起来是“进入 CLI”，是因为它们发布了一个 bin；本项目也通过 `package.json` 的 `bin.nausicaa` 提供同样的入口。

## 开发门禁

```bash
npm run typecheck     # 严格 TypeScript 检查
npm test              # 离线 unit、protocol 与 recovery 测试
npm run test:smoke    # 构建并验证真实 CLI 产物
npm run eval          # 确定性的 Main-only 与 Main+Teto 合同评测
npm run check         # 执行完整本地门禁
```

真实 OpenRouter 测试不会默认运行。只有同时设置 `NAUSICAA_LIVE_TESTS=1`、`OPENROUTER_API_KEY`、`NAUSICAA_EVAL_MODEL` 和正数 `NAUSICAA_EVAL_BUDGET_USD` 时，才会运行最多 5 次请求的 Main-only 与 Main+Teto 有界对照；费用硬上限仍应由 OpenRouter 的限额 key 保证。

## 设计原则

- **KISS**：小内核、少概念、窄接口。
- **DIY**：自研差异化 runtime，复用成熟的通用能力。
- **Model-forward**：不把弱模型时期的临时补偿固化进内核。
- **Evidence-driven**：能力与性能主张必须通过可复现实验验证。
- **Ledger-driven**：持久事实属于账本，可丢弃状态由事实重建。

项目仍处于实验阶段，请勿依赖未发布的 API。
