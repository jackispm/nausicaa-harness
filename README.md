# Nausicaa

Nausicaa 是一个面向长程任务的轻量 Agent harness。它以一条专注执行的 Main lane 为主线，并让低频辅助 lane 在旁路独立观察、提出建议；辅助线不会复制完整对话，也不会阻塞主线。

这是 `0.1.0` 本地 beta。核心运行、恢复和权限合同已有离线测试，但 API、命令行参数和 daemon 协议仍可能调整；不要把它当作生产集群或稳定 SDK。

## Beta 边界

本版本可以在单机工作区内使用：

- Main + Teto 的 TUI、print 和 JSON 入口，共用同一个 Run/Ledger 恢复边界。
- Mowe 内置工具、`apply_patch`、Skills/MCP edge（显式配置后）以及 capability boundary。
- Worker 和跨 Run A2A 仅在显式启用、且由 host 提供身份/roster/router 时出现；缺少授权 composition 时 fail closed。
- Awareness 的 `/agents`、`/topology` 和 `--topology` 只读投影；没有可见来源时报告 `unavailable`，不伪造 active 节点。
- 本地 daemon Host、Ledger-backed wake、Run lease，以及显式 `--daemon-worker-command` detached worker composition。

以下内容不属于本 beta 的发布承诺：集群或远程 daemon、跨机器 transport、可写 remote attach、插件 marketplace/热加载、常驻 worker fleet、真实 MCP marketplace 验证、Worker 质量 uplift 或 Phase 2.4 A/B 结论。OpenRouter smoke 是一次受控的 provider 兼容性检查，不是质量或性能证明。

## 当前能力

- 基于 [`pi-ai`](https://github.com/earendil-works/pi/tree/main/packages/ai) 接入模型与 OpenRouter，不重复实现 provider 调度。
- 启动消息支持 Prime 风格的 `@image` 输入；图片作为 `pi-ai` 原生多模态内容传递，不维护自定义 provider 协议。
- Main 运行有界 tool loop，并通过 Mowe 统一执行单个或批量调用。默认只读目录包含 `read_file`、`read_many`、`list_files`、`grep`、`find`、`file_info` 和四个安全 Git 查看工具（status/log/show/diff）；按需可启用 `read_image`、网络、写入、Shell 与后台进程。搜索、读取、图片、Git 和元数据结果均有大小限制。
- 默认 `workspace` 权限还提供原子写入 `write_file`、精确替换 `edit`，以及受同一路径边界保护的 `directory_create`、`path_copy`、`path_move` 和 `path_delete`；macOS 或可用 bubblewrap 的 Linux 上还提供无公网、写路径限制在工作区的前台 `bash`。沙箱不可用时 Bash 会 fail closed，文件工具仍可用；也可在 TUI 用 `/permissions read-only` 收紧。
- `--allow-shell` 独立启用宿主级 `bash` 和后台进程工具。这是显式高权限能力：命令可按当前系统账号权限读写工作区外部；它不会随 `--allow-write` 自动开启，反之亦然。
- 在嵌入式运行时中，`allowProcessJobs` 与 `allowShell` 同时开启后提供 `process_start`、`process_status`、`process_output`、`process_kill` 和 `process_list`，用于在同一 Run 内启动、观察、读取、终止和诊断有界后台进程；Job 固定以工作区为 cwd、按 Run 隔离、输出有界并支持超时/取消。默认注册表仍为进程内模式；daemon 可按 Run 自动注入 `FileProcessJobRegistry`，持久化启动/终态快照，重启时将未绑定 OS 进程的 running 记录标为 orphaned，不假装恢复进程。普通 TUI/print 仍保持进程内注册表，避免把一次性会话状态写入磁盘。
- `--allow-network` 启用 `web_fetch` 和批量 `web_search`。网络工具默认关闭，使用同源重定向、SSRF、响应大小、超时和取消边界；部署可通过 provider seam 替换搜索/抓取后端。
- 工作区文件工具和沙箱 Bash 保护 `.env*`、`.git`、`.nausicaa`、私钥和常见凭据路径；高权限宿主 `bash` 不受此路径策略约束。
- JSONL Ledger 与内容寻址 Store 保存事实和大对象，支持 checkpoint 与 Run 恢复。
- Teto 辅助线读取固定大小的观察帧，低频检查目标偏离、意图缺失和更优方法。
- Advice 通过持久 Inbox 在 Main 的自然边界进入上下文，可明确接受、延后或拒绝。
- Worker 作为显式 opt-in 的 bounded sub-agent lane，通过 A2A 接收 Main 委派的任务；它共享上述受限只读目录（包括 `read_many` 与 Git 查看工具），最多 2 次模型轮次和 4 次只读工具调用，不能写文件、执行 Shell、访问网络或继续委派；Worker 模型明确声明视觉输入能力时，默认 catalog 还会加入 `read_image`；默认不会增加模型调用。
- 启用 Worker 时，Main 额外获得 `delegate_task`；Teto live 模式额外获得 `respond_to_advice`。两者仍经过 Mowe 的 catalog、schema admission、operation ID、结果投影和恢复边界。
- TTY 默认进入持续 Session：一个 Run 可包含多个 Turn，支持 steering、取消、恢复和 `--continue`。
- 运行中按 Enter 注入 steering，按 Alt+Enter 排队 follow-up；输入和 ACK 都写入 Ledger。
- `pi-tui` 只负责终端 surface；SessionController、Ledger 和模型执行保持独立，未来可接桌面 UI。
- `--daemon` 启动最小长期 Host，并在 `<data-dir>/daemon/control.sock` 提供 Unix JSONL 控制面；客户端可发送 `start`、`stop`、`status`、`attach`、`detach`、`wake` 和 `events.subscribe`。Host 会在启动时及运行期间串行扫描 `<data-dir>/runs`，重新排队已持久化但尚未投递的输入和被进程中断的活动 Turn；它不会抢占正被交互 TUI 持有的 Run。`--attach <run-id>` 可从另一个本地进程打开只读 TUI，按 Ledger cursor 分页追赶并在 socket 重启后续接；transcript 仍从同一个 Ledger/Store 投影。daemon 与普通可写 TUI/print 入口分离，当前仍是本地单进程 Host。

当前没有通用 graph DSL 或插件市场；Mowe 的 `MoweCatalog` 提供窄的本地注册 seam，便于接入自定义 AgentTool，而不要求引入 Cordis 级插件运行时。

生态 edge 通过用户级 `~/.nausicaa/settings.json` 的 `edges` 声明接入。宿主也可以在显式
信任 workspace 后加载项目级 `.nausicaa/settings.json`；当前 CLI 默认不信任项目设置。
配置只描述来源，
不会自行启动进程或获得权限；adapter registry 在刷新时校验 manifest，并为后续 Turn
创建带 generation 的不可变工具快照。Main 通过 Mowe 使用快照，Worker 仍只获得固定的
只读工具集。交互会话中的 `/edges` 只读取状态投影，不直接管理 edge 进程。
每个 Main Turn 在工具和上下文组装前捕获一次 registry snapshot；Turn 期间的刷新只影响后续
Turn。Skill 正文只会在显式选择后以有界、标记为不可信的 Fukai context 数据进入 Main，
不会成为工具、`projectInstructions`、系统策略或 Worker 上下文。

```json
{
  "edges": {
    "enabled": true,
    "refreshOnStart": true,
    "sources": [
      { "sourceId": "local-skills", "type": "skill", "location": "skills" },
      { "sourceId": "review-server", "type": "mcp", "command": "fake-mcp", "args": ["--stdio"] }
    ]
  }
}
```

命令行可用 `--edges`、`--no-edges` 和 `--refresh-edges` 覆盖本次启动的 edge 开关。
`--refresh-edges` 只请求宿主刷新；没有 registry 时也不会进行网络或外部进程调用。当前
实现没有插件热加载、自动安装市场或完整的远程 daemon parity；当前 attach 仅观察本机 Unix socket，不提供输入、取消或网络 transport。插件声明保持诊断状态。

`read_file` 支持按行分页，`read_many` 可在共享字节预算内并发读取最多 16 个窗口；`grep` 与 `find` 在截断时返回绑定查询的续页 cursor。Git 查看工具使用固定参数、受保护路径过滤、可信可执行文件解析和有界输出，不要求开放 Shell。`write_file` 只在已有目录中写文件，不负责创建目录；`edit` 要求被替换文本唯一匹配。工作区文件工具会拒绝绝对路径、`..`、已有符号链接和受保护路径；当前威胁模型不覆盖同一系统账号下的其他进程并发替换文件系统节点。两档 `bash` 都有独立的环境变量白名单、取消/超时和有界输出；`workspace` 档再由 Seatbelt 或 bubblewrap 限制写入、网络和进程边界，`full-access` 档则明确运行在宿主权限下。需要异步观察开发服务器或测试进程时使用 Full Access 提供的 Job 生命周期工具，而不是在前台 `bash` 中放任后台命令。

`workspace` Bash 是与 Codex/DeepSeek 同类的 OS 路径沙箱，不是 copy-on-write 容器。预先存在于工作区的硬链接仍可能指向工作区外同一文件对象；Linux 的 network namespace 会隐藏常规 `/run` socket，但不能证明所有非标准路径的 Unix socket 都不可达。Nausicaa 的结构化文件工具仍拒绝硬链接。对完全不可信的仓库应使用 `read-only`，或在独立容器/VM 中运行 Nausicaa；不要把 `workspace` 当成跨用户或恶意宿主隔离。

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
nausicaa --print "查看这个项目如何安装"
nausicaa --json "检查这个项目的 package 脚本"

# 恢复或附着当前项目最近的 Run
nausicaa --resume <run-id>
nausicaa --continue

# 默认可以读取、修改并在 OS 沙箱内执行当前工作区；宿主 Shell 与网络仍关闭
nausicaa --model openrouter:openai/gpt-5-mini "修复这个项目"

# 需要访问宿主或运行后台进程时单独开启高权限 Shell
nausicaa --allow-shell "运行测试并分析失败原因"
```

不使用 `npm link` 时也可以从构建产物生成本地 beta tarball。`package.json` 保持
`private: true`，因此不会被误发布到 npm registry；tarball 安装仍会带上运行时依赖和
`nausicaa` bin：

```bash
npm run build
npm pack
npm install --global ./nausicaa-0.1.0.tgz
nausicaa --help
```

daemon 与 topology 都是显式的本机操作。daemon 默认只持有本地 Host；detached worker
必须由调用方提供外部命令，参数可重复传入：

```bash
nausicaa --daemon --data-dir .nausicaa
nausicaa --daemon --daemon-worker-command /path/to/worker \
  --daemon-worker-arg --stdio --daemon-worker-arg --workspace=/path/to/project
nausicaa --attach <run-id> --data-dir .nausicaa
nausicaa --topology
nausicaa --topology --json
```

`--attach` 当前是同一台机器上的只读 TUI，不提供输入、取消或网络 transport。`--topology`
是只读检查并且不能与任务、Run 恢复、daemon 或权限选项组合。

`@image` 用于启动消息，可重复指定；交互中按 `Ctrl+V`（Windows 为 `Alt+V`）可从剪贴板插入 Prime 风格的 `[image #N]` 标记。提交时只附带仍出现在文本中的标记，删除标记会移除附件，当前进程内通过撤销或历史恢复标记后仍可重新附带。模型必须在 `pi-ai` 模型目录中声明 `image` 输入能力；文本模型会在发起 provider 请求前给出错误。路径必须相对当前工作区，且不能穿过符号链接、硬链接、受保护目录或 `..`；支持 PNG、JPEG、GIF、WebP，按文件内容而非扩展名识别。每次最多 4 张、单张最多 3 MiB、总计最多 10 MiB，当前不会自动缩放。图片内容随 Run 持久化并可恢复；Teto 不会因此读取额外的完整主线内容。

也可设置 `NAUSICAA_MODEL`，省略每次调用的 `--model`。交互会话默认使用 `workspace` 权限：可读写当前工作区，并可在可用的 OS 沙箱内运行前台 Bash，但不开放宿主 Shell、网络或后台进程。`/permissions` 可在 `read-only`、`workspace`、`full-access` 三档之间切换；`full-access` 等同于明确开放工作区写入、宿主 Shell、网络和后台进程，因此边界会直接显示在底部状态栏。`/plan [prompt]` 进入只读 Plan 模式，`/mode` 可在 Default 与 Plan 间切换。

`/goal` 查看当前 Run 的长期目标，`/goal <statement>` 修订它；`/session` 打开当前工作区的 Run 选择器，`/session <run-id>` 可直接切换；`/copy` 将最后一条 assistant 回答复制到系统剪贴板。普通消息仍是各自 Turn 的当前任务。运行状态默认写入工作区的 `.nausicaa/`；使用 `nausicaa --resume <run-id>` 从已提交边界继续。若恢复时发现结果未知的工具操作，CLI 会打印 operation ID 和显式结算命令；确认其应按失败处理后再执行该命令，运行时不会自动重放副作用。

交互命令的最小 beta surface 如下：`/agents`（`/topology` 别名）查看只读 Awareness，`/permissions [read-only|workspace|full-access]` 切换 capability，`/plan [prompt]` 进入只读 Plan，`/skills [refresh|select <id>|deselect <id>]` 管理下一 Turn 的 Skill，`/edges [refresh]` 查看 edge 状态。命令只提交 Ledger 允许的状态变更；它们不会绕过当前 Turn 的 snapshot 或权限边界。

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

### 0.1.0 beta release checklist

1. 在目标 commit 上依次运行 `npm run typecheck`、`npm run build`、`npm test`、`npm run test:smoke` 和 `git diff --check`；不要并发运行会清理 `dist` 的命令。
2. 运行 `npm pack --dry-run`，确认清单只有 `dist/`、`README.md`、`THIRD_PARTY_NOTICES` 和 npm 必需的 `package.json`，不含 `.env*`、`.nausicaa/`、`.local/`、`docs/`、`test/`、日志或 `node_modules/`。
3. 若 root 决定执行唯一一次 live smoke，先确认模型、软预算、`$1` 硬限额 key 和干净工作树；否则将 provider compatibility 标为 pending。
4. 发布说明不得声称 Phase 2.4、Worker uplift、真实 marketplace MCP、远程/集群 daemon 或长期生产稳定性已经验证。

真实 OpenRouter 测试不会默认运行。beta smoke 固定使用 `openrouter:tencent/hy3`，只有同时设置 `NAUSICAA_LIVE_TESTS=1`、`OPENROUTER_API_KEY`、`NAUSICAA_LIVE_MODEL=tencent/hy3`（也接受带 `openrouter:` 前缀）和正数 `NAUSICAA_EVAL_BUDGET_USD` 时才会发起请求；预检还要求工作树干净。请求最多 5 次、单次输出最多 128 token、wall-clock 45 秒，默认软预算为 `$0.85`；provider 未返回可解析的非负 usage/cost 时立即失败关闭。运行形态如下，key 只存在于当前进程环境，不会写入文件或产物：

```bash
OPENROUTER_API_KEY='(只放进当前进程环境)' \
NAUSICAA_LIVE_TESTS=1 \
NAUSICAA_LIVE_MODEL=tencent/hy3 \
NAUSICAA_EVAL_BUDGET_USD=0.85 \
npm run test:live -- --no-file-parallelism
```

smoke fixture 会要求 Main 通过 `read_file` 读取小型 README，再依据工具结果回答；结果摘要只写入被忽略的 `.nausicaa/evals/`，公开字段为 model、request count、usage、cost、status 和 commit。通过只表示 provider、工具循环和本地 harness 接线可运行，不代表 Teto uplift、Worker 质量收益或 Phase 2.4 release。历史 Main-only/Main+Teto 对比、缓存 probe 和视觉验收必须额外设置 `NAUSICAA_LIVE_SCENARIO=legacy`，不会被 beta 命令隐式启动。

上述 live 命令只允许 root 在离线门禁通过后执行一次；执行前应把 OpenRouter key 硬限额设为
`$1.00`。缺少 key、模型或预算时预检应跳过且不发请求，失败应记录为 provider
compatibility pending，不改动核心工具合同。

Phase 2.4 能力门禁与普通 live smoke 分开。完整实验使用预注册 manifest 中冻结的模型、10 个任务、3 次重复和 4 个 arm，不读取 `NAUSICAA_EVAL_MODEL`。执行前必须设置 `NAUSICAA_PHASE24_EVAL=1`、`OPENROUTER_API_KEY` 和正数 `NAUSICAA_EVAL_BUDGET_USD`，并保持工作树干净；然后运行 `npm run eval:live`。每次运行写入独立的 `.nausicaa/evals/phase-2.4/<evaluation-id>/`，也可用路径安全的 `NAUSICAA_EVAL_ID` 固定名称。命令会立即校验 raw digest、manifest、配对报告和 release decision；证据不完整或预注册收益门未通过时返回非零，但仍保留可审计结果。`npm run eval:verify -- <目录>` 可稍后重新验证。测试内预算只能在请求间停止后续调用，费用硬上限仍应由 OpenRouter 的限额 key 保证。

Worker 的真实收益实验与普通 live smoke 分开。只有明确设置 `NAUSICAA_WORKER_EVAL=1`、`OPENROUTER_API_KEY` 和正数 `NAUSICAA_WORKER_EVAL_BUDGET_USD`，并保持工作树干净时，才运行 `npm run eval:worker:live`。该预算是响应后记账的软停止阈值，在途请求可能越过它；硬上限必须由 OpenRouter 限额 key 保证。实验使用冻结的 `main-only` / `main-worker` 双 arm、同一模型和配对任务，记录物理 provider 重试、四类 token、缓存、真实请求重叠和 TaskGraph join；结果写入被忽略的 `.nausicaa/evals/worker-live/`。`npm run eval:worker:verify -- <目录>` 只做离线重建和篡改检查。默认 `npm run check` 不会调用真实 provider。

本 beta 发布不要求、也不会在默认门禁中运行 Phase 2.4 全量 A/B、Worker uplift 或真实
MCP marketplace 验证；这些实验继续留在 roadmap，不能由一次低预算 smoke 推断。

## 设计原则

- **KISS**：小内核、少概念、窄接口。
- **Standing on shoulders**：通用能力按“直接依赖、移植、薄适配、自研”的顺序决策；创新资源只投入多 lane 拓扑、Teto 与 lane 协作。
- **DIY**：只自主掌握决定 Nausicaa 差异化的 runtime，不把重复造轮子误当成自主可控。
- **Model-forward**：不把弱模型时期的临时补偿固化进内核。
- **Evidence-driven**：能力与性能主张必须通过可复现实验验证。
- **Ledger-driven**：持久事实属于账本，可丢弃状态由事实重建。

项目仍处于实验阶段，请勿依赖未发布的 API。
