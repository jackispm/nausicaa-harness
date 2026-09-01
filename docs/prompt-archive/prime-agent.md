# Prime Agent Prompt Archive

## Provenance

- Repository: `/Users/gongdongjie/Downloads/primeagent`
- Commit: `7787f07415d843b9a800f6a4720e0c739bd608e5`
- Version: `prime-agent@0.7.2`
- Collected: 2026-09-01
- Exact source snapshots: [`../reference-prompts/snapshots/prime-agent`](../reference-prompts/snapshots/prime-agent)

## Archive Boundary

This page is a source-level Prime Agent reference. Nausicaa does not import the
page or the snapshot directory, and does not inherit Prime's RLM/IPython prompt
merely because it is archived here. The live Nausicaa request map is maintained
separately in `.local/PROMPT-ARCHIVE-AND-NAUSICAA-PROMPT-REVIEW-REPORT.md`.

Prime Agent is a Pi-derived coding agent with an RLM/IPython control plane and continual-harness state. Its final prompt is assembled from active tools, skills, recursion depth, parent identity, harness state, and custom context, so the source builders are more useful than a single captured string.

## System Prompt And RLM

Sources: [`coding-agent-system-prompt.ts`](../reference-prompts/snapshots/prime-agent/coding-agent-system-prompt.ts), [`rlm-prompts.ts`](../reference-prompts/snapshots/prime-agent/rlm-prompts.ts), and [`prompts-index.ts`](../reference-prompts/snapshots/prime-agent/prompts-index.ts).

The base prompt begins:

```text
You are a general purpose agent that uses code to solve tasks.
You solve tasks by breaking down problems into sub-tasks, writing and executing code, observing results, and iterating one step at a time.
When you are done, stop calling tools and state your final answer.
```

It includes the working directory, conversation-log path, recursive depth, pre-installed Python packages, native project-environment rules, `%%bash` first-line requirements, persistent IPython state, skill import/CLI contracts, and continual-harness CRUD. When recursion is enabled it adds the native `await rlm('sub-task')` admission contract, child naming/model selection, parent/sibling/child messaging and observation rules, fan-in through files, and child cleanup. `buildSubagentGuidance()` adds when/why delegation guidance after the base RLM prompt.

The IPython control block explicitly says not to treat IPython as the external project's native runtime, not to install project dependencies into the kernel, to bind tool results to named variables, and to keep shell state inside one `%%bash` cell or use persistent kernel equivalents.

Custom prompts receive project context, visible skills, date/cwd, child doctrine, harness-state menus, and append text according to the options in the system builder. Default prompts receive RLM text, delegation guidance, harness state, additional guidance, project context, skills, and append text.

## Compaction And Branches

Sources: [`compaction.ts`](../reference-prompts/snapshots/prime-agent/compaction.ts), [`compaction-utils.ts`](../reference-prompts/snapshots/prime-agent/compaction-utils.ts), [`branch-summarization.ts`](../reference-prompts/snapshots/prime-agent/branch-summarization.ts), and [`messages.ts`](../reference-prompts/snapshots/prime-agent/messages.ts).

Prime retains Pi's summarization system prompt and structured sections: Goal, Constraints & Preferences, Progress (Done/In Progress/Blocked), Key Decisions, Next Steps, and Critical Context. It also retains the update-summary and split-turn prefix prompts, exact-path/function/error preservation, `<conversation>` input framing, and `<summary>` message wrappers. Branch summaries use the same branch preamble and section contract.

## Goal, Autonomous, And Side-Question Prompts

- [`goals.ts`](../reference-prompts/snapshots/prime-agent/goals.ts) emits continuation, budget-limit, objective-updated, and completion-budget messages. The objective is user-provided task data, never higher-priority instructions; completion requires an explicit `await goal.complete()` after auditing every requirement.
- [`autonomous.ts`](../reference-prompts/snapshots/prime-agent/autonomous.ts) supplies the default no-human continuation and gate-failure continuation. Autonomous mode keeps working until evaluator/verifier limits stop it and requires evidence for blockers.
- [`side-question.ts`](../reference-prompts/snapshots/prime-agent/side-question.ts) tells the model to answer a side question from existing context only, without tools or adding the exchange to the main session.
- [`daemon-session-summarizer.ts`](../reference-prompts/snapshots/prime-agent/daemon-session-summarizer.ts) asks for a dashboard status line using only the required `COMPLETED`/`NEEDS_INPUT` tags and chooses `NEEDS_INPUT` when uncertain.
- [`package-manager-cli.ts`](../reference-prompts/snapshots/prime-agent/package-manager-cli.ts) contains the update/restart continuation prompt used when a package operation replaces the running process.

## Continual Harness Refinement

[`refinement.ts`](../reference-prompts/snapshots/prime-agent/refinement.ts) contains the `/refine` system prompt and automatic review gate. It distinguishes reusable memories, skills, prompt notes, and subagent specs from one-off session progress; requires evidence-backed edits; and preserves the RLM-native skill and delegation call contracts. The prompt can be invoked locally or globally, with stricter persistence rules for global scope.

## Subagents And Examples

[`subagent-prompts/`](../reference-prompts/snapshots/prime-agent/subagent-prompts) contains scout/planner/worker/reviewer roles and implement/scout-and-plan orchestration. [`examples/`](../reference-prompts/snapshots/prime-agent/examples) contains opt-in handoff, Q&A, custom compaction, plan-mode, preset, structured-output, Claude rules, pirate-mode, and tic-tac-toe prompts.

The base agent's RLM prompt and the example prompts are separate layers: examples demonstrate extensions and are not automatically injected into every Prime Agent session.

## Open Inputs

Harness-state entries, installed skills, project instruction files, custom system prompts, append prompts, extension hooks, tool schemas, and child/user messages are runtime inputs. The source snapshots preserve how they are interpolated and ordered; this archive does not replace those values with a guessed default.
