# OpenRouter Beta Smoke Runbook

状态：受控一次性操作清单（2026-09-01）
基线：`main@f87bd15`；真实运行必须使用 S6 审查后的集成提交。

## Launch checklist

- [ ] 在待运行提交上记录 `git rev-parse HEAD`；确认它包含 S5/S6 审查结果。
- [ ] 确认工作树干净：`git status --porcelain --untracked-files=all` 无输出。不要用 dirty worktree 运行。
- [ ] 在 OpenRouter dashboard 设置不超过 `$1.00` 的账户/请求 hard cap，并保持页面可观察。
- [ ] 仅在当前 shell 进程导出 `OPENROUTER_API_KEY`；不要把 key 写入 `.env`、配置、日志、Ledger 或任何 artifact。
- [ ] 设置固定目标和本地软预算：

  ```text
  NAUSICAA_LIVE_TESTS=1
  NAUSICAA_LIVE_MODEL=tencent/hy3
  NAUSICAA_EVAL_BUDGET_USD=0.85
  ```

- [ ] 确认 `NAUSICAA_LIVE_SCENARIO` 未设置为 `legacy`；legacy comparison/cache/vision probes 不属于本次 smoke。

- [ ] 先执行离线预检：

  ```text
  npx vitest run test/eval/openrouter-beta-harness.test.ts --no-file-parallelism
  ```

- [ ] 预检通过后，只执行一次真实命令：`npm run test:live`。不要追加 Phase 2.4、Worker 或 A/B 参数。

## Stop conditions

立即 Ctrl-C 并保留已有证据：dashboard 费用接近 `$1.00`、请求数超过 5、目标模型不是 `openrouter:tencent/hy3`、本地护栏触发、出现未预期的 provider/tool 行为，或进程不再可观察。中断后不自动重试；由 release owner 先分类再决定后续动作。

## Evidence and boundaries

脱敏 artifact 位于 `.nausicaa/evals/openrouter-beta-*.json`，公开摘要只复制 harness 的 `publicBetaSmokeSummary` 输出。记录字段固定为：`commit`、`model`、`requestCount`、可用时的 `usage`、可可靠时的 `costUsd`、`elapsedMs`、`status`、`failureCategory`、`nextOwner`。禁止保留 prompt、workspace 内容、raw response、路径或 key；artifact 不提交 git。

成功只说明固定 provider/model 能完成 bounded Main tool loop，并不等价于质量 benchmark、Teto/Worker uplift、Phase 2.4 实验或发布批准。失败写成事实 beta note，使用既定 failure taxonomy，不因一次模型结果猜测性修改核心合同。
