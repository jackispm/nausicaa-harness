# OpenRouter Topology Smoke

This is a development smoke, not a reliability benchmark or a release gate.
Every Main, Worker, member, reducer, and Teto model response must come from the
selected real OpenRouter provider. No model response or tool call is scripted.
Prompts explicitly request the topology under test, so passing does not prove
that the model will spontaneously select that topology for an ordinary task.

The runner reuses Nausicaa's pi-ai adapter, workspace tools, `executeRun`, and
`SessionController`. Its evaluation-only meter adds concurrent cost reservations
because the existing beta meter tracks one current output cap and is not a
parallel-lane reservation mechanism. No new production runtime is introduced.

## Run

From the repository root, with Node >=22.19 and dependencies installed:

```sh
NAUSICAA_TOPOLOGY_LIVE=1 node --env-file=.env --import tsx test/eval/topology-live-cli.ts
```

The existing `.env` must explicitly select `NAUSICAA_LIVE_MODEL=openrouter:<id>`.
Authentication uses `OPENROUTER_API_KEY` or the application's saved credential
store. Credentials are not written to reports. Alternatively omit `--env-file`
and supply the model through the environment, using saved credentials.

Run an individual case before committing the batch budget:

```sh
NAUSICAA_TOPOLOGY_LIVE=1 NAUSICAA_TOPOLOGY_CASES=workspace node --env-file=.env --import tsx test/eval/topology-live-cli.ts
```

`NAUSICAA_TOPOLOGY_CASES` accepts comma-separated IDs from the table below.
Unknown or duplicate IDs fail before any provider call. Exit status is nonzero
when any selected case fails or is skipped.

## Cases

| ID | Actual task | Evidence required |
| --- | --- | --- |
| `workspace` | Read a synthetic checkout, write JSON, read it back | Correct file and answer; successful write and later read |
| `worker` | Delegate subtotal computation, request the result in a second user turn | Worker read, completed task result, committed Main consumption |
| `team-dag` | Two independent readers feed a dependent total calculator | Concurrent requests, definition before dispatch, dependency settlement order and context, join, Main acceptance |
| `team-calendar` | Two builders write a week-calendar/Todo site; a dependent reviewer inspects it | Actual member writes, no implicit task limits, more than two calls per member, public review, lead turn completion followed by automatic report continuation, consumed results and acceptance |
| `team-peer-reducer` | Members exchange checkout facts; optional reducer synthesizes | Correct numeric evidence sent after file reads and consumed in both directions, successful members, ordered reduction lifecycle, read-only reducer tools, Main acceptance |
| `resume-fork` | Recall an unpredictable identifier after reopening, then modify the total in a fork | Current turns complete, inherited context, durable fork lineage, unchanged parent Ledger |
| `teto` | Main opens an observer, requests a shipping reminder, reports amounts back | Labelled public observations, actual messaging tools, both directions consumed and visible in the hydrated transcript, no duplicate messages or self-addressed sends, token round trip |
| `team-cancel` | Main creates then cancels a reader Team | Durable cancellation and cancelled task outcome, no later success |

Worker and Teto use the persistent session entry point intentionally. They do
not keep a one-shot Main alive automatically. A later explicit user turn is
part of these cases and is recorded, not hidden as autonomous wake behavior.
Peer consumption matches the exact numeric evidence message and a later
committed recipient step. A consumed greeting cannot satisfy the check, nor
can a correct-looking number sent before the member reads its source. A member
finishing before receiving its peer's evidence fails even if both sends queued.
The peer/reducer prompt explicitly explains that a no-tool reply enters the
runtime's completion boundary; `team_status` is a read, not a waiting primitive.
Run budget exhaustion remains a failed case, and its blocker is recorded.
The Teto token check proves that a token-bearing observer message was consumed
and the token appeared in Main's answer. It does not prove that Main adopted a
suggestion: even a negative acknowledgement may mention the token. Inspect the
transcript separately before claiming useful observer intervention.

Cancellation can interrupt a paid call without final usage. The meter then
disables further paid calls, which can also prevent Main's cancellation answer.
The report distinguishes durable cancellation evidence from overall case
completion; incomplete cost accounting must not be interpreted as zero cost.
Cancellation is last for this reason and may need a separately authorized batch.

## Limits And Artifacts

- Default batch guard: $0.75, at most 80 ModelPort calls. Configurable with
  `NAUSICAA_TOPOLOGY_BUDGET_USD` and `NAUSICAA_TOPOLOGY_MAX_REQUESTS`, with
  ceilings of $0.85 and 100 calls. These count logical adapter calls, not
  provider-internal HTTP attempts.
- Each call: at most 2,048 output tokens, 160,000 serialized input bytes,
  and 60 seconds. Main turns and background waits also have finite limits.
- Cost reservations use conservative byte counts and the installed provider
  catalog. They are a local admission guard, not a provider billing guarantee.
  Missing cost, ambiguous failure, or exceeded limits disables later calls.
- A newly created temporary workspace contains only synthetic checkout files.
  Shell, network tools, external projects, and real user data are not granted.
  Provider access itself still requires the environment's network permission.
- `.local/live-topology/<timestamp>-<suffix>/` contains `report.json`,
  `calls.json`, and per-case event JSON. Prompts, synthetic responses, tool names,
  context, latency, usage, repository revision, and dirty state are retained.
- Complete Ledger and content-addressed artifacts remain in the temporary
  workspace root recorded by the report. They are not automatically deleted;
  the OS may eventually clean its temporary directory.

The suite does not yet exercise cross-Run A2A, member-owned Teto, observer skills,
deadline-best-effort, daemon restart, arbitrary Team resume, streaming steering,
or long-running topology scale. The calendar case checks file structure and
JavaScript syntax; it does not substitute for browser interaction tests.
A single pass is not statistical reliability.

## Offline Verification

```sh
npm run typecheck
node node_modules/vitest/vitest.mjs run test/unit/topology-live-model.test.ts --no-file-parallelism
node node_modules/vitest/vitest.mjs run test/unit/topology-live-evidence.test.ts --no-file-parallelism
```

These checks validate the smoke's local safety mechanisms. They do not count
as successful OpenRouter or multi-topology live runs.

## Recorded Review

On September 10, the updated Worker probe passed. A calendar Team probe then
passed all 14 collaboration checks: parallel member writes, prerequisite order,
more than two calls per member, public review, automatic lead continuation,
and committed result consumption. It used 28 provider calls and reported
$0.1164986064. The reviewer identified a CSS/class integration defect that the
lead disclosed but accepted; this run proves the collaboration path, not full
website acceptance. An earlier attempt exhausted the smoke's 140,000-token Run
guard; the outer test allowance is now 1,000,000 tokens and 24 steps per lead
activation, with the same cost/request guards and no task-specific limits.
Local report IDs: `2026-09-10T01-17-41-564Z-WpJFyF` and
`2026-09-10T01-25-48-055Z-pGp5Qb`.

A follow-up restored that same session and reused its `ui` and `qa` members.
The UI member repaired the actual CSS, then QA read both files and reported
PASS. The probe used 16 calls and $0.0853241356, but did not pass end to end:
the restored QA lacked its `team_message` tool, and the smoke's concurrent
cost-reservation guard stopped the final lead turn before it consumed QA's
report. The guard belongs to the paid-test runner, not the member task policy.
The reviewed record is `followup-eHCrAm/reviewed-report.json`; it distinguishes
the successful file repair and reports from the incomplete final handoff.
The timed-out probe then explicitly cancelled its Team during cleanup. A later
assignment was correctly rejected; a cancelled Team is not a reusable fixture
for recovery validation. Separate protocol tests cover restored group access
and preservation of workspace and nested-Team grants.

A separate, minimal Team probe passed all 15 checks after the channel fix:
one member completed, the session closed normally, the same Run reopened,
and the same member read group history, posted a group message, and returned
a report that automatically woke the lead and was consumed. The record is
`group-resume-ODiyr5/report.json`; its 16 additional calls cost $0.0327957608.
Only the test provider wrapper serialized paid requests to stay within its
conservative reservation guard, so this probe does not measure model-call
concurrency. Replaying this probe's saved events after the status-projection
fix produces no false task or reply anomalies, while the task remains in
review. No additional provider calls were used for that projection check.

The September 7-8 reliability review found and fixed status-context bloat,
member completion missing already-arrived mail, recovery resetting attempt
budgets, and empty reducer summaries. Those probes used the old per-task controls.
As of 0.1.4, live prompts use the same compact tool contract as production, with
no per-task budget arguments. The smoke's outer cost/request guards remain
test-only controls.

The latest Team probe completed reduction and Main acceptance with the correct
total, but remains failed overall: one model used `grand_total` instead of the
requested `subtotal`, and spent its allowance correcting unsupported message
kinds, leaving that member partial. The evaluator intentionally does not treat
that as all-member success. Teto's latest 12 transport/presentation checks
passed. See [the review record](review-rounds-2026-09-07.md) for report IDs,
cost-accounting limits, and exact offline verification results.
