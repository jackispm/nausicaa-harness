# OpenRouter Beta Smoke and Capability MiniEval Runbook

状态：受控一次性操作清单（2026-09-01）
基线：release owner 指定的 clean integration commit；真实运行必须使用干净提交。

首批推荐唯一入口是 `npm run test:beta:live`。它只运行显式选择的 Compatibility/MiniEval cases；不会运行 legacy、vision、cache、Phase 2.4 或 Worker eval。

## Launch checklist

- [ ] 在待运行提交上记录 `git rev-parse HEAD`；确认它包含 S5/S6 审查结果。
- [ ] 确认工作树干净：`git status --porcelain --untracked-files=all` 无输出。不要用 dirty worktree 运行。
- [ ] 在 OpenRouter dashboard 为本批次设置 hard cap，并保持页面可观察；本地 `NAUSICAA_EVAL_BUDGET_USD` 必须不高于该 hard cap。
- [ ] 仅在当前 shell 进程导出 `OPENROUTER_API_KEY`；不要把 key 写入 `.env`、配置、日志、Ledger 或任何 artifact。
- [ ] 设置固定目标和本地软预算：

  ```text
  NAUSICAA_LIVE_TESTS=1
  NAUSICAA_BETA_EVAL_MODEL=openrouter:tencent/hy3
  NAUSICAA_BETA_CASES=compatibility,bugfix
  NAUSICAA_EVAL_BUDGET_USD=<positive finite batch budget>
  NAUSICAA_EVAL_MAX_REQUESTS=<selected-manifest ceiling; compatibility+bugfix=5>
  ```

  `NAUSICAA_LIVE_MODEL` belongs only to the separate legacy `npm run test:live` smoke and is not read by the beta capability suite.

- [ ] 确认 `NAUSICAA_LIVE_SCENARIO` 未设置为 `legacy`；legacy comparison/cache/vision probes 不属于本次 smoke。

- [ ] 先执行离线预检：

  ```text
  npx vitest run test/eval/beta-capability.test.ts test/eval/openrouter-beta-harness.test.ts --no-file-parallelism
  ```

- [ ] 预检通过后，只执行一次真实命令：`npm run test:beta:live`。不要自动重试或追加其他 live/eval 命令。启用 `NAUSICAA_LIVE_TESTS=1` 时任何预检失败都必须使命令失败；不得以绿色空跑代替。

## Stop conditions

立即 Ctrl-C 并保留已有证据：dashboard 费用接近本批次 hard cap、请求数接近 `NAUSICAA_EVAL_MAX_REQUESTS`、本地护栏触发、出现未预期的 provider/tool 行为，或进程不再可观察。中断后不自动重试；由 release owner 先分类再决定后续动作。

## Evidence and boundaries

脱敏 artifact 位于 `.nausicaa/evals/beta-capability-*.json` 和 `.nausicaa/evals/openrouter-beta-*.json`，公开摘要只复制 `publicBetaCapabilitySummary`/`publicBetaSmokeSummary` 输出。MiniEval 每题独立报告 `pass`、`fail` 或 `not-run-budget`，并记录真实工具名、hash、请求/usage/cost、延迟和执行 commit。禁止保留 prompt、workspace 内容、raw response、绝对路径或 key；artifact 不提交 git。

Compatibility 成功只说明 provider/tool/Main loop 连通，不进入 capability 分数。Bugfix 成功必须由 Agent 退出后的外部 grader 证明：初始测试失败、最终 `node add.test.js` 在 `WorkspaceCommandSandbox` 的禁网和硬超时边界内返回 0、测试 bytes/hash 不变、允许目录无额外改动且轨迹包含读取和 mutation。sandbox 不可用时 fail closed。结果不等价于 Teto/Worker uplift、Phase 2.4 实验或发布批准。
