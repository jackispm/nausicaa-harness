# Testing And Acceptance

状态：开发前契约。测试分为“runtime 是否正确”和“Agent 是否更有效”两条独立证据链；真实模型结果不能替代确定性测试，mock 通过也不能证明产品收益。

## 测试分层

| 层级 | 模型与环境 | 目标 | PR 门禁 |
| --- | --- | --- | --- |
| Unit | 无模型 | schema、reducer、预算、cadence | 是 |
| Protocol | scripted/faux `pi-ai` | 真实 Main/Teto/Ledger/A2A 事件轨迹 | 是 |
| Recovery | scripted model + fault injection | torn write、取消、重试、resume | 是 |
| Artifact smoke | 构建后的 bin + 临时 workspace | 安装、启动、最小 Run | 是 |
| Live integration | OpenRouter | provider、流式、工具循环、usage | 否，定时运行 |
| Capability eval | OpenRouter + 固定任务集 | Main+Teto 的真实净收益 | release gate |

离线层只替换模型、网络和时钟边界；Scheduler、Main、Teto、Ledger、Store 和 A2A 必须使用真实实现。断言事件、状态和产物，不断言模型措辞，也不相信 Agent 的完成声明。

## 首期不变量

- 同一 Ledger 在任意已提交前缀 replay 后产生相同 projection。
- 半行写入、序号缺口、重复消息和崩溃不会改写已提交事实或重复副作用。
- 20 个普通 Main LLM 调用产生 3～4 个 Teto pass，滚动上限为 4，Teto token 不超过 Run 模型 token 的 10%。
- Teto 在没有 Fukai 实例时可运行；其输入不包含 transcript、CoT、工具日志、文件树、`changedRefs` 或事件索引。
- ObservationFrame 的动态部分不超过 600 input tokens，Advice 不超过 200 output tokens；超限必须显式标记。
- Advice 只在 Main 自然边界消费，支持 `accept`、`defer`、`reject`、TTL 和幂等恢复。
- Teto 超时、失败或取消不阻塞 Main。
- 每种存储实现必须通过同一套 conformance tests。

## OpenRouter 真实测试

真实测试必须显式开启，不能因开发者机器存在密钥而自动运行：

```text
OPENROUTER_API_KEY
NAUSICAA_LIVE_TESTS=1
NAUSICAA_EVAL_MODEL=<pinned-model-id>
NAUSICAA_EVAL_BUDGET_USD=<hard-cap>
```

密钥只从进程环境读取，禁止进入配置、日志、Ledger、快照或失败输出；错误路径必须使用 canary secret 做脱敏回归测试。每次运行记录实际模型/provider、参数、仓库 commit、任务版本、usage、缓存结果和请求时间。原始 trace 放在被忽略的 `.nausicaa/evals/`；公开报告只包含脱敏指标。超出费用或请求上限时立即停止。

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
