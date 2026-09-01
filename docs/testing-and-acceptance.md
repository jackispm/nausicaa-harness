# Testing And Acceptance

状态：Living contract（2026-08-28）。测试分为“runtime 是否正确”和“Agent 是否更有效”两条独立证据链；真实模型结果不能替代确定性测试，mock 通过也不能证明产品收益。

## 测试分层

| 层级 | 模型与环境 | 目标 | PR 门禁 |
| --- | --- | --- | --- |
| Unit | 无模型 | schema、reducer、预算、cadence | 是 |
| Protocol | scripted/faux `pi-ai` | 真实 Main/Teto/Ledger/A2A 事件轨迹 | 是 |
| Recovery | scripted model + fault injection | torn write、取消、重试、resume | 是 |
| Artifact smoke | 构建后的 bin + 临时 workspace | 安装、启动、最小 Run | 是 |
| Interactive components | `pi-tui` virtual terminal + scripted model | 多轮 Turn、流式、工具、队列、中断、退出/恢复 | 是 |
| Built interactive PTY | 构建后的 bin + 真实 POSIX PTY | 默认入口、首帧、输入和 terminal restore | 是；无 POSIX Python 时明确 skip |
| Live integration | OpenRouter | provider、流式、工具循环、usage | 否，定时运行 |
| Capability eval | OpenRouter + 固定任务集 | Main+Teto 的真实净收益 | release gate |

离线层只替换模型、网络和时钟边界；Scheduler、Main、Teto、Ledger、Store 和 A2A 必须使用真实实现。断言事件、状态和产物，不断言模型措辞，也不相信 Agent 的完成声明。

## 首期不变量

- 同一 Ledger 在任意已提交前缀 replay 后产生相同 projection。
- 半行写入、序号缺口、重复消息和崩溃不会改写已提交事实或重复副作用。
- 20 个普通 Main LLM 调用产生 3～4 个 Teto pass，滚动上限为 4，Teto token 不超过 Run 模型 token 的 10%。
- Teto 在没有 Fukai 实例时可运行；其输入不包含 transcript、CoT、工具日志、文件树、`changedRefs` 或事件索引。
- 新生成的 Teto Advice 只允许 `orientation` 或 `intent-gap`；旧 `method-alternative` 仅可被兼容回放读取。
- Teto 对正常进展、方法偏好、工具/代码问题、证据不足、`truncated` 帧和 frame 内的诱导文本返回 `silent`；只有明确的实质性偏航或重要遗漏才生成 whisper。
- ObservationFrame 的动态部分不超过 600 input tokens，Advice 不超过 200 output tokens；超限必须显式标记。
- Advice 只在 Main 自然边界消费，支持 `accept`、`defer`、`reject`、TTL 和幂等恢复。
- Teto 超时、失败或取消不阻塞 Main。
- Main、Worker、Teto、Reflection 共享同一 Run token 硬上限；并发调用先预约、后按实际 usage 结算，provider 成功但输出协议失败仍计费，纯 provider 失败或取消释放预约，重启不得重置辅助 lane 用量。
- 每种存储实现必须通过同一套 conformance tests。
- 构建后的默认 `nausicaa` 在 TTY 中进入 interactive；非 TTY 不得隐式挂起。
- 顺序 Turn 复用 Run/Ledger，step 与幂等 key 按 Turn 隔离；steering/follow-up 在正确边界交付，8 条上限和重启后不丢不重均可验证。
- `--resume`/`--continue` 只附着 canonical workspace 相同的 Run，候选只读扫描不抢 writer lock；跨 workspace、损坏和占用状态明确失败。
- Ctrl+C、`/cancel`、`/exit`、EOF、SIGTERM、provider failure 和忽略取消的 provider 都有明确的 Turn/Run 状态，在 2 秒 grace 内关闭 writer；取消不得伪装成 `run.failed`。
- transient stream delta 先于 durable assistant/Turn terminal event，取消后没有迟到 assistant；print/JSON 与 TTY 的分流在伪终端和 pipe 下都有测试。
- `input.admitted` 的 ACK 丢失可用同一 `inputId` 重试且不重复；每个 admission 前缀可 replay repair，pending input 在重启后按 sequence 自动 promotion。
- `maxMainStepsPerActivation` 耗尽写 `turn.waiting`，显式 resume 只增加一段 allowance、不重置 `turnStep`；Run 硬 token 预算耗尽后不可绕过。
- unknown tool operation 通过 query 或 `--resolve-operation`/`/resolve` 形成 terminal result 后才解除 blocker；waiting Turn 恢复，abandoned Turn 保持 cancelled并只继续队列，不得自动重执行。
- 同一 lane/Run 的稳定 system/tool prefix 和 `sessionId` 在多 Turn、steering、图片及进程恢复后不漂移；每次请求记录 prefix、截断和 context build 证据。provider 不暴露 cache counter 时必须报告 `unknown`，不能伪称 miss。
- Main 的 `model.requested.contextManifest`（schema v1）包含完整六槽位、prefix/dynamic hash、watermark 和 policy version，且不包含 Prompt 正文；没有显式 capsule 时 `compaction` 槽位必须为 `empty`。版本化 compaction 事件、projection 和 Core commit/read 合同必须独立通过；自动摘要 provider 接入后再增加触发、失败和请求数门禁。
- 显式 compaction provider 必须受输入/输出 token 和 wall-clock 预算约束；失败、超时、stale、重复提交及 Store/hash 不一致不能把未验证摘要送入 Main。默认未配置 provider 时，Main 请求数、请求内容和预算行为与基线逐请求一致。

## OpenRouter Beta Smoke

普通 beta smoke 是一次受控的 provider/tool-loop 兼容性检查，必须显式开启；它不是质量 benchmark，也不代表 Teto、Worker 或 Phase 2.4 的收益。

### Exact launch contract

在 S6 审查过的干净提交上运行。只从当前进程环境读取密钥，禁止写入 `.env`、settings、Ledger、快照、日志或 artifact：

```text
OPENROUTER_API_KEY=<current-process-only-secret>
NAUSICAA_LIVE_TESTS=1
NAUSICAA_LIVE_MODEL=tencent/hy3
NAUSICAA_EVAL_BUDGET_USD=0.85
```

离线预检（不会连接 provider）：

```text
npx vitest run test/eval/openrouter-beta-harness.test.ts --no-file-parallelism
```

通过预检后，release owner 只执行一次真实命令：

```text
npm run test:live
```

该 harness 固定选择器 `openrouter:tencent/hy3`、最多 5 个请求、每请求最多 128 output tokens、45 秒 wall-clock timeout，并以 `$0.85` 本地软预算守住 `$1` dashboard hard cap。费用、请求数或模型目标出现异常时立即中断；不要为同一结果重跑。

运行前确认 `NAUSICAA_LIVE_SCENARIO` 未设为 `legacy`；legacy comparison、cache 和 vision probes 不属于本次 smoke。

### Failure taxonomy

| Category | Meaning | Next owner |
| --- | --- | --- |
| `provider-auth-failure` | OpenRouter 鉴权、账户或 provider 可达性失败 | provider-owner |
| `model-tool-call-incompatibility` | 固定模型无法完成请求/工具协议，或 usage 形状不兼容 | runtime-owner |
| `timeout` | provider 或 harness 超过 wall-clock 边界 | harness-owner |
| `budget-guard` | 请求数、token 或费用护栏触发 | release-owner |
| `harness-defect` | 预检、artifact、清理或测试实现本身出错 | harness-owner |
| `nondeterministic-quality-result` | 运行完成但任务质量在重复样本间不稳定 | evaluation-owner |

失败只形成事实 beta note（含错误类别和下一责任人），不能因单模型失败臆测修改核心合同。原始 provider trace 不进入公开报告。

### Redacted result record

每次运行的公开记录只允许下列字段：`commit`、`model`、`requestCount`、provider 提供时的 `usage`、可可靠计算时的 `costUsd`、`elapsedMs`、`status`（scenario status）、`failureCategory`、`nextOwner`。`prompt`、workspace 内容、raw response、文件路径和任何 key 都禁止出现。脱敏 JSON 位于被忽略的 `.nausicaa/evals/openrouter-beta-*.json`；发布说明只复制 `publicBetaSmokeSummary` 输出。

### Separate evaluation tracks

普通 beta smoke 使用 `npm run test:live`。预注册 Phase 2.4 实验仍需 `NAUSICAA_PHASE24_EVAL=1`，只通过 `npm run eval:live` 启动；模型来自冻结 manifest，工作树必须干净，并以 `npm run eval:verify -- .nausicaa/evals/phase-2.4/<evaluation-id>` 独立校验 raw digest、manifest、配对报告和 release decision。`hold` 是有效实验结果，但不是 release gate 成功。

Phase 3 Worker 的确定性机制门使用独立合同，通过 `npm run eval:worker` 运行；它不调用真实 provider，也不能替代后续 OpenRouter Worker 收益实验。以上两类 eval 与一次性 beta smoke 相互独立，不共享成功定义或预算结论。

## 能力验收

同一仓库快照、模型、工具、总预算和任务种子运行四个配对组：

1. `Main-only`。
2. `Main + 等成本自我反思`。
3. `Main + Teto shadow`：生成 Advice，但 Main 不可见。
4. `Main + Teto live`。

优先使用隐藏测试、命令退出码、文件内容、引用正确性和副作用记录评分；主观项才使用盲评。重复运行并报告置信区间。实验前在 manifest 中冻结任务集、样本量、权重和门槛，禁止看结果后修改。

```text
netUtility = taskQuality - costWeight * cost
             - latencyWeight * p95 - noiseWeight * harmfulAdvice
uplift = netUtility(Main+Teto) - netUtility(equal-budget baseline)
```

只有 `uplift` 的预设置信区间高于零、Teto 成本满足预算且整体任务不退化，才能称为有效改进。

## 开发门禁

首个实现应预留计划中的命令契约：`test:unit`、`test:protocol`、`test:recovery`、`test:smoke`、`test:live` 和 `eval`。前三层必须快速、离线、可重复；live/eval 不进入普通 PR。每个 bug 先增加最小回归用例，每个新事件或 lane 行为同时增加 replay 和失败路径测试。

参考取舍：采用 Pi 的 Faux Provider 与离线 harness、DeepSeek 的属性测试和持久化故障注入、Prime 的持久状态/子 Agent 协议测试，以及 Codex 的 mock model server、interrupt/resume、安全与多平台 smoke。覆盖率只用于发现空白，不作为替代行为验收的目标。
