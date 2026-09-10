# OpenRouter Topology Smoke

This is a development smoke, not a reliability benchmark or a release gate.
Every Main, Worker, member, reducer, and Teto model response must come from the
selected real OpenRouter provider. No model response or tool call is scripted.
Most prompts explicitly request the topology under test. The separate
`team-natural-calendar` case uses an ordinary Chinese product request, without
tool names, prefilled arguments, or anti-polling instructions. It asks for
separate development/review responsibilities and leaves coordination to the agent.
The `teto-restraint` and `teto-flight-replay` cases instead supply fixed owner observations to isolate
Teto's behavior; its observer responses still come from the real provider.

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
| `team-sequential` | Two readers finish, then the lead adds a calculator to the same Team | Concurrent reader requests, incremental membership, result handoff, ordered work, Main acceptance |
| `team-calendar` | Two builders write a week-calendar/Todo site; the lead then adds a reviewer | Actual member writes, no implicit task limits, public review, repairs/review as needed, consumed results and acceptance |
| `team-natural-calendar` | Build a calendar/Todo site from a plain Chinese request in an empty workspace | Multiple working members, real member file writes, automatic group reports, consumed results, no forced pause, final answer after acceptance, parseable HTML scripts |
| `team-peer-reducer` | Members exchange checkout facts; optional reducer synthesizes | Correct numeric evidence sent after file reads and consumed in both directions, successful members, ordered reduction lifecycle, read-only reducer tools, Main acceptance |
| `resume-fork` | Recall an unpredictable identifier after reopening, then modify the total in a fork | Current turns complete, inherited context, durable fork lineage, unchanged parent Ledger |
| `teto` | Main opens an observer, requests a shipping reminder, reports amounts back | Labelled public observations, actual messaging tools, both directions consumed and visible in the hydrated transcript, no duplicate messages or self-addressed sends, token round trip |
| `teto-restraint` | Feed the production observer fixed greetings, routine reads, intent drift and a direct A2A question | Silence on routine observations, a concrete warning on an unauthorized write plan, correctly associated direct reply, durable source projections present in model context |
| `teto-flight-replay` | Replay five public observation phases from the reported flight-game session with sanitized paths and IDs | Silence without failed tool attempts during the first three routine phases; later Team-phase messages retained for human review; real observer inference and source projection |
| `team-cancel` | Main creates then cancels a reader Team | Durable cancellation and cancelled task outcome, no later success |

Worker and the `teto` round-trip use the persistent session entry point intentionally. They do
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
- Each call: 2,048 output tokens by default, optionally up to 4,096 with
  `NAUSICAA_TOPOLOGY_OUTPUT_TOKENS`, 160,000 serialized input bytes,
  and 120 seconds. Calendar lead turns allow ten minutes for development,
  review, repairs and re-review. Other turns and background waits also have finite limits.
- Cost reservations use conservative byte counts and the installed provider
  catalog. They are a local admission guard, not a provider billing guarantee.
  Missing cost, ambiguous failure, or exceeded limits disables later calls.
- A newly created temporary workspace contains only synthetic checkout files,
  or starts empty for the natural-language calendar case.
  Shell, network tools, external projects, and real user data are not granted.
  Provider access itself still requires the environment's network permission.
- `.local/live-topology/<timestamp>-<suffix>/` contains `report.json`,
  `calls.json`, and per-case event JSON. Prompts, synthetic responses, tool names,
  context, latency, usage, repository revision, and dirty state are retained.
- Complete Ledger and content-addressed artifacts remain in the temporary
  workspace root recorded by the report. They are not automatically deleted;
  the OS may eventually clean its temporary directory.

Teto is disabled for the Team probes so their results isolate Team collaboration;
they do not establish the behavior of Teams with the default observer enabled.
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

The first flight-polish run used the production interactive entry point with
a recorded terminal and OpenRouter in the existing `test1` workspace. Nausicaa
created a developer, waited for its real edit and report, added an independent
reviewer, then accepted and summarized. All 13 collaboration/TUI checks passed;
49 model calls took 696 seconds and reported $0.1980594044. However, independent
Chrome testing still failed to start the game, and four routine Teto messages
were unhelpful. The overall task is recorded as failed despite structural
collaboration success. Record: `flight-team-live/2026-09-10T19-34-11-152Z-kk6WsL`.

A follow-up used the literal source CLI under a PTY and resumed the same Run.
Nausicaa's own developer repaired duplicate pointer-lock requests from the
start-button click bubbling to the document handler. Independent Chrome checks
then passed WebGL initialization, start, thrust, keyboard and mouse steering,
Escape pause, resume, and absence of JavaScript/console errors (nine checks).
The host did not edit the game. The screenshot still showed an oversized cockpit
frame obscuring the horizon; functional checks alone do not establish visual
quality, so that observation was returned to Nausicaa for review.

This CLI also exposed a TUI CPU stall: a live profile attributed 92.1% of samples
to rendering. The fixed-margin HStack alternated full and inset widths and
invalidated historical tool/Markdown caches on every frame. With the same
57-block transcript, the corrected single-width Box rendering averaged 0.69ms
after warmup; the earlier HStack measurement averaged about 220ms. These are
local timing samples, not a cross-machine performance guarantee. All 216
geometry comparisons passed, including narrow widths, ANSI, CJK and cursor
markers. The resumed CLI's Teto still sent some routine/speculative notes;
the explicit observation objective improves the recorded probes but does not
guarantee useful advice throughout a natural long task.

After Escape and source-CLI resume, the same Run retained its developer and
reports; measured lead context construction fell from earlier 159–168 second
samples to 79–131ms. The model also stopped once after promising to assign a
reviewer, without making that call. This is retained as a failed coordination
step, and the default prompt now explicitly requires acting before ending a
turn. Neither a successful model stop nor that prompt rule is an automatic
test of whether a natural-language request was fulfilled.

This natural run exposed a gap in the short observation fixtures. Replaying
its original long Chinese request reproduced routine A2A; merely tightening
the system wording did not solve it. The final change gives each observer
request an explicit observation objective and specifies plain-text `NO_UPDATE`
with no tool calls. Four recorded phases then produced zero tool calls and
zero A2A, with successful provider responses. Record:
`teto-recorded-plain-text-hjfRiV`. The separate restraint probe also passed,
including an actual intent-drift warning and a linked direct reply. Record:
`2026-09-10T19-52-00-541Z-2FG2Fi`. These passes are individual samples, not a
guarantee that every future unsolicited message is useful.

To repeat the recorded-input check with an existing local Run:

```sh
NAUSICAA_TETO_RECORDED_LIVE=1 node --env-file=.env --import tsx test/eval/teto-recorded-restraint.ts /absolute/path/to/ledger.jsonl replay
```

The script reads source artifacts, runs only Teto, and writes a separate
report under `.local`. A model failure cannot count as silence.

The updated observer passed both restraint probes with
`openrouter:deepseek/deepseek-v4-pro-0813`: all five flight observation phases
were silent, a deliberate read-only violation produced one warning, and a
direct question received one linked reply. Nine model calls reported
$0.0109814628 with complete accounting. Record:
`2026-09-10T19-27-19-344Z-ZGMi6q`. These are fixed owner observations with real
Teto inference, not proof of general restraint or a natural Team task.

The 0.1.6 calendar probe passed all 12 checks using
`openrouter:deepseek/deepseek-v4-pro-0813`. The lead and two persistent members
completed development, review, repair, re-review, a second repair for old-data
migration, and final acceptance. Six tasks produced six group reports and six
`task_wait` calls. There were 37 model calls (17 lead, 11 developer, 9 reviewer),
taking 273 seconds and reporting $0.1880691912 with complete accounting.
Record: `2026-09-10T18-03-56-369Z-Ctixn5`. Teto was disabled in this natural task;
JavaScript parsing was checked, browser interaction was not.

The separate Teto restraint probe passed all 14 checks with the same model:
greetings and a routine read plan produced `NO_UPDATE` without A2A, a write plan
contradicting an explicit read-only request produced one concrete warning, and
a direct A2A question received one correctly associated reply. All eight fixed
source events were projected into real observer requests. Four calls cost
$0.0051570112. Record: `2026-09-10T18-10-46-739Z-1uhZAS`. Its report includes the
production system prompt, source observations, responses and receipts. The owner
is a synthetic fixture, so this is not an end-to-end natural task.
An earlier record (`2026-09-10T18-08-25-523Z-UqKtHN`) remains marked failed because
the probe incorrectly required the warning to use `message.inform`; the model
sent the same actionable warning through the legal `question.ask` variant.
The checker now accepts both kinds without changing the production prompt.

The 0.1.5 natural-language calendar probe passed all 12 collaboration checks
from an empty workspace. The lead created a developer, added a reviewer after
the file existed, reassigned repairs to that developer, requested a re-review,
recorded acceptance and delivered a final answer. Four tasks produced four
automatic group reports and four distinct `task_wait` calls; the lead used
12 model calls and all lanes used 27. The run took 227 seconds and reported
$0.1398078572 with complete usage accounting. The reviewer recovered from a
Git-status error in the non-Git workspace. This validates collaboration and
script parsing, not browser behavior or model reliability across repeated runs.
Record: `2026-09-10T08-44-44-424Z-jIy0fJ`.

Two preceding natural-language attempts remain failed records. The first was
cancelled by the test's former four-minute turn guard during re-review
(`2026-09-10T07-25-39-268Z-S7MxAu`). The second exposed incorrect routing of
member status/wait tools to only their nested Teams, then hit the test's former
60-second request timeout (`2026-09-10T08-25-15-562Z-7AMyPS`). Their known costs
were $0.1160490584 and $0.090132878 respectively, with incomplete final-request
accounting. The routing fix has separate protocol coverage for membership,
nested Teams, denied access and self-wait rejection. The final probe used the
same Chinese request, ten-minute turn guard and 120-second request guard.

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

The earlier September 7-8 peer/reducer probe completed reduction and Main acceptance with the correct
total, but remains failed overall: one model used `grand_total` instead of the
requested `subtotal`, and spent its allowance correcting unsupported message
kinds, leaving that member partial. The evaluator intentionally does not treat
that as all-member success. Teto's latest 12 transport/presentation checks
passed. See [the review record](review-rounds-2026-09-07.md) for report IDs,
cost-accounting limits, and exact offline verification results.
