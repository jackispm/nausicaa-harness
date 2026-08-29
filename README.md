# Nausicaa

Nausicaa 是一个面向长程任务的轻量 Agent harness。它以一条专注执行的 Main lane 为主线，并让低频辅助 lane 在旁路独立观察、提出建议；辅助线不会复制完整对话，也不会阻塞主线。

这是早期可运行版本，接口与命令行参数尚未稳定。

## 当前能力

- 基于 [`pi-ai`](https://github.com/earendil-works/pi/tree/main/packages/ai) 接入模型与 OpenRouter，不重复实现 provider 调度。
- 启动消息支持 Prime 风格的 `@image` 输入；图片作为 `pi-ai` 原生多模态内容传递，不维护自定义 provider 协议。
- Main 运行有界 tool loop，并通过 Mowe 统一执行单个或批量调用。默认只读目录包含 `read_file`、`read_many`、`list_files`、`grep`、`find`、`file_info` 和四个安全 Git 查看工具（status/log/show/diff）；按需可启用 `read_image`、网络、写入、Shell 与后台进程。搜索、读取、图片、Git 和元数据结果均有大小限制。
- 默认 `workspace` 权限还提供原子写入 `write_file`、精确替换 `edit`，以及受同一路径边界保护的 `directory_create`、`path_copy`、`path_move` 和 `path_delete`；可在 TUI 用 `/permissions read-only` 收紧。
- `--allow-shell` 独立启用 `bash`。这是显式高权限能力：命令虽从工作区启动，但可按当前系统账号权限读写工作区外部；它不会随 `--allow-write` 自动开启，反之亦然。
- 在嵌入式运行时中，`allowProcessJobs` 与 `allowShell` 同时开启后提供 `process_start`、`process_status`、`process_output`、`process_kill` 和 `process_list`，用于在同一 Run 内启动、观察、读取、终止和诊断有界后台进程；Job 固定以工作区为 cwd、按 Run 隔离、输出有界并支持超时/取消。默认注册表仍为进程内模式；daemon 可按 Run 自动注入 `FileProcessJobRegistry`，持久化启动/终态快照，重启时将未绑定 OS 进程的 running 记录标为 orphaned，不假装恢复进程。普通 TUI/print 仍保持进程内注册表，避免把一次性会话状态写入磁盘。
- `--allow-network` 启用 `web_fetch` 和批量 `web_search`。网络工具默认关闭，使用同源重定向、SSRF、响应大小、超时和取消边界；部署可通过 provider seam 替换搜索/抓取后端。
- 工作区文件工具始终保护 `.env`、`.git`、`.nausicaa`、私钥和常见凭据路径，即使开启 `--allow-write` 也不能访问；高权限 `bash` 不受此路径策略约束。
- JSONL Ledger 与内容寻址 Store 保存事实和大对象，支持 checkpoint 与 Run 恢复。
- Teto 辅助线读取固定大小的观察帧，低频检查目标偏离、意图缺失和更优方法。
- Advice 通过持久 Inbox 在 Main 的自然边界进入上下文，可明确接受、延后或拒绝。
- Worker 作为显式 opt-in 的 bounded sub-agent lane，通过 A2A 接收 Main 委派的任务；它共享上述受限只读目录（包括 `read_many` 与 Git 查看工具），最多 2 次模型轮次和 4 次只读工具调用，不能写文件、执行 Shell、访问网络或继续委派；Worker 模型明确声明视觉输入能力时，默认 catalog 还会加入 `read_image`；默认不会增加模型调用。
- 启用 Worker 时，Main 额外获得 `delegate_task`；Teto live 模式额外获得 `respond_to_advice`。两者仍经过 Mowe 的 catalog、schema admission、operation ID、结果投影和恢复边界。
- TTY 默认进入持续 Session：一个 Run 可包含多个 Turn，支持 steering、取消、恢复和 `--continue`。
- 运行中按 Enter 注入 steering，按 Alt+Enter 排队 follow-up；输入和 ACK 都写入 Ledger。
- `pi-tui` 只负责终端 surface；SessionController、Ledger 和模型执行保持独立，未来可接桌面 UI。
- `--daemon` 启动最小长期 Host，并在 `<data-dir>/daemon/control.sock` 提供 Unix JSONL 控制面；客户端可发送 `start`、`stop`、`status`、`attach`、`detach`、`wake` 和 `events.subscribe`。启动时会扫描 `<data-dir>/runs`，重新排队已持久化但尚未投递的输入和被进程中断的活动 Turn；它与普通 TUI/print 入口分离，当前仍是本地单进程 Host。

当前没有通用 graph DSL 或插件市场；Mowe 的 `MoweCatalog` 提供窄的本地注册 seam，便于接入自定义 AgentTool，而不要求引入 Cordis 级插件运行时。

`read_file` 支持按行分页，`read_many` 可在共享字节预算内并发读取最多 16 个窗口；`grep` 与 `find` 在截断时返回绑定查询的续页 cursor。Git 查看工具使用固定参数、受保护路径过滤、可信可执行文件解析和有界输出，不要求开放 Shell。`write_file` 只在已有目录中写文件，不负责创建目录；`edit` 要求被替换文本唯一匹配。工作区文件工具会拒绝绝对路径、`..`、已有符号链接和受保护路径；当前威胁模型不覆盖同一系统账号下的其他进程并发替换文件系统节点。`bash` 有独立的环境变量白名单、取消/超时和有界输出，但不会继承这些文件路径限制；需要异步观察开发服务器或测试进程时，使用上述 Job 生命周期工具，而不是在 `bash` 中放任后台命令。

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

# 显式启用 Worker sub-agent；默认模型复用 Main
nausicaa --worker "并行检查这个项目的安装前置条件"

# 用视觉模型分析工作区内的图片；路径含空格时需将整个 @参数加引号
nausicaa --model openrouter:<vision-model> @screenshots/error.png "解释这个错误"
nausicaa --model openrouter:<vision-model> '@screenshots/error state.png' "比较界面状态"

# 脚本或 CI 使用 one-shot，不进入交互界面
nausicaa -p "查看这个项目如何安装"

# 恢复或附着当前项目最近的 Run
nausicaa --resume <run-id>
nausicaa --continue

# 默认可以读取和修改当前工作区；Shell 与网络仍保持关闭
nausicaa --model openrouter:openai/gpt-5-mini "修复这个项目"

# 需要执行命令时单独开启高权限 Shell；它不要求也不等同于 --allow-write
nausicaa --allow-shell "运行测试并分析失败原因"
```

`@image` 用于启动消息，可重复指定；交互中按 `Ctrl+V`（Windows 为 `Alt+V`）可从剪贴板插入 Prime 风格的 `[image #N]` 标记。提交时只附带仍出现在文本中的标记，删除标记会移除附件，当前进程内通过撤销或历史恢复标记后仍可重新附带。模型必须在 `pi-ai` 模型目录中声明 `image` 输入能力；文本模型会在发起 provider 请求前给出错误。路径必须相对当前工作区，且不能穿过符号链接、硬链接、受保护目录或 `..`；支持 PNG、JPEG、GIF、WebP，按文件内容而非扩展名识别。每次最多 4 张、单张最多 3 MiB、总计最多 10 MiB，当前不会自动缩放。图片内容随 Run 持久化并可恢复；Teto 不会因此读取额外的完整主线内容。

也可设置 `NAUSICAA_MODEL`，省略每次调用的 `--model`。交互会话默认使用 `workspace` 权限：可读写当前工作区，但不开放宿主 Shell 或网络。`/permissions` 可在 `read-only`、`workspace`、`full-access` 三档之间切换；`full-access` 等同于明确开放工作区写入、宿主 Shell、网络和后台进程，因此边界会直接显示在底部状态栏。`/plan [prompt]` 进入只读 Plan 模式，`/mode` 可在 Default 与 Plan 间切换。

`/goal` 查看当前 Run 的长期目标，`/goal <statement>` 修订它，`/copy` 将最后一条 assistant 回答复制到系统剪贴板；普通消息仍是各自 Turn 的当前任务。运行状态默认写入工作区的 `.nausicaa/`；使用 `nausicaa --resume <run-id>` 从已提交边界继续。若恢复时发现结果未知的工具操作，CLI 会打印 operation ID 和显式结算命令；确认其应按失败处理后再执行该命令，运行时不会自动重放副作用。

`npm run dev -- <参数>` 通过 `tsx` 直接运行 TypeScript 源码，是开发调试入口，不是产品交互模型。构建后的产品入口是 `nausicaa`；`npm start -- <参数>` 直接运行 `dist/cli.js`。因此别人项目看起来是“进入 CLI”，是因为它们发布了一个 bin；本项目也通过 `package.json` 的 `bin.nausicaa` 提供同样的入口。

## 开发门禁

```bash
npm run typecheck     # 严格 TypeScript 检查
npm test              # 离线 unit、protocol 与 recovery 测试
npm run test:smoke    # 构建并验证真实 CLI 产物
npm run eval          # 确定性的 Main-only 与 Main+Teto 合同评测
npm run eval:worker   # 确定性的 Main/Worker 拓扑与 A2A 机制评测
npm run eval:verify -- .nausicaa/evals/phase-2.4/<evaluation-id>
npm run eval:cache:verify -- .nausicaa/evals/phase-2.3-cache.json
npm run check         # 执行完整本地门禁
```

真实 OpenRouter 测试不会默认运行。`npm run test:live` 会读取本地 `.env`；只有同时设置 `NAUSICAA_LIVE_TESTS=1`、`OPENROUTER_API_KEY`、`NAUSICAA_LIVE_MODEL`（未设置时回退到 `NAUSICAA_EVAL_MODEL`）和正数 `NAUSICAA_EVAL_BUDGET_USD` 时，才运行最多 7 次请求的 Main-only/Main+Teto 工具循环。缓存 probe 另有最多 2 次请求及独立的 `NAUSICAA_CACHE_EVAL_BUDGET_USD`；它通过真实 Session/MainLoop 生成脱敏 Ledger 摘要、runtime cache projection、commit 和请求时间证据，并可由 `eval:cache:verify` 独立复验。视觉验收还需显式设置具备图片输入能力的 `NAUSICAA_VISION_MODEL` 和正数 `NAUSICAA_VISION_BUDGET_USD`，且最多发起 1 次请求；没有视觉模型时不会退回默认模型。

Phase 2.4 能力门禁与普通 live smoke 分开。完整实验使用预注册 manifest 中冻结的模型、10 个任务、3 次重复和 4 个 arm，不读取 `NAUSICAA_EVAL_MODEL`。执行前必须设置 `NAUSICAA_PHASE24_EVAL=1`、`OPENROUTER_API_KEY` 和正数 `NAUSICAA_EVAL_BUDGET_USD`，并保持工作树干净；然后运行 `npm run eval:live`。每次运行写入独立的 `.nausicaa/evals/phase-2.4/<evaluation-id>/`，也可用路径安全的 `NAUSICAA_EVAL_ID` 固定名称。命令会立即校验 raw digest、manifest、配对报告和 release decision；证据不完整或预注册收益门未通过时返回非零，但仍保留可审计结果。`npm run eval:verify -- <目录>` 可稍后重新验证。测试内预算只能在请求间停止后续调用，费用硬上限仍应由 OpenRouter 的限额 key 保证。

Worker 的真实收益实验与普通 live smoke 分开。只有明确设置 `NAUSICAA_WORKER_EVAL=1`、`OPENROUTER_API_KEY` 和正数 `NAUSICAA_WORKER_EVAL_BUDGET_USD`，并保持工作树干净时，才运行 `npm run eval:worker:live`。该预算是响应后记账的软停止阈值，在途请求可能越过它；硬上限必须由 OpenRouter 限额 key 保证。实验使用冻结的 `main-only` / `main-worker` 双 arm、同一模型和配对任务，记录物理 provider 重试、四类 token、缓存、真实请求重叠和 TaskGraph join；结果写入被忽略的 `.nausicaa/evals/worker-live/`。`npm run eval:worker:verify -- <目录>` 只做离线重建和篡改检查。默认 `npm run check` 不会调用真实 provider。

## 设计原则

- **KISS**：小内核、少概念、窄接口。
- **Standing on shoulders**：通用能力按“直接依赖、移植、薄适配、自研”的顺序决策；创新资源只投入多 lane 拓扑、Teto 与 lane 协作。
- **DIY**：只自主掌握决定 Nausicaa 差异化的 runtime，不把重复造轮子误当成自主可控。
- **Model-forward**：不把弱模型时期的临时补偿固化进内核。
- **Evidence-driven**：能力与性能主张必须通过可复现实验验证。
- **Ledger-driven**：持久事实属于账本，可丢弃状态由事实重建。

项目仍处于实验阶段，请勿依赖未发布的 API。
