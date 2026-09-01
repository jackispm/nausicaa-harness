# Prompt Archive and Nausicaa Runtime Prompt Review

Version: `prompt-review-2026-09-01.v1`
Baseline: `main@c9bf684` (`update beta documentation status`)
Scope: offline source audit only. No provider, network, MCP, or runtime code was changed.

This report separates three things that are easy to conflate: (1) copied source
snapshots, (2) the request assembled by Nausicaa today, and (3) proposed future
prompt changes. The files under `docs/reference-prompts/snapshots/` are not read
by Nausicaa and are not automatically sent to any model.

## 1. Fact Table

The archive provenance is recorded in `docs/reference-prompts/README.md`:

| Harness | Local checkout and archived revision | Snapshot boundary |
| --- | --- | --- |
| Pi | `/Users/gongdongjie/Downloads/pi`, `1defa151e0c1dac87d38a2d0ac09d67f817b30f9`, `pi-monorepo@0.0.3` | Source copied under `docs/reference-prompts/snapshots/pi/` |
| Prime Agent | `/Users/gongdongjie/Downloads/primeagent`, `7787f07415d843b9a800f6a4720e0c739bd608e5`, `prime-agent@0.7.2` | Source copied under `docs/reference-prompts/snapshots/prime-agent/` |
| DeepSeek Harness | `/Users/gongdongjie/Downloads/deepseek-harness`, `b150a551b8d465e31e418e1b2eaf5e79bbb7d28e`, `@deepseek-ai/dsh-root@0.1.1-rc.2` | Source copied under `docs/reference-prompts/snapshots/deepseek-harness/` |

| Harness channel | Assembly and trigger (local source) | Actual channel | Stable prefix? |
| --- | --- | --- | --- |
| Pi ordinary Main | `snapshots/pi/coding-agent-system-prompt.ts:27-168`: default identity, selected tool snippets, tool-conditioned guidelines, optional append, project context, visible skills when `read` exists, and cwd. The custom branch at `:46-71` replaces the default body but keeps append/context/skills/cwd. | One system string; provider tool schemas remain separate inputs. | Default identity and fixed guidelines are stable; selected tools, files, skills, append text, and cwd are runtime data. |
| Pi tools | Tool prompt snippets and descriptions under `snapshots/pi/tool-prompts/`; the coding-agent builder only lists snippets supplied by the caller (`coding-agent-system-prompt.ts:79-126`). | Tool schema plus optional system-prompt snippet/guideline. | Schema/snippet is stable only for a fixed tool selection. |
| Pi compaction | `snapshots/pi/agent-compaction.ts:424-459,545-575`: standalone summarizer system prompt and a user message containing serialized `<conversation>` and the exact checkpoint template. | Separate summarizer request; not an ordinary Main turn. | Summarizer instruction is stable; serialized conversation and prior summary are dynamic. |
| Pi branch/resume | `snapshots/pi/coding-agent-branch-summarization.ts:253-280` builds a branch-only summary prompt; `agent-messages.ts` wraps the result as a summary message. | Separate branch-summary request and then a reintroduced history message. | Preamble/template stable; branch content dynamic. |
| Prime ordinary Main | `snapshots/prime-agent/coding-agent-system-prompt.ts:38-168` calls `buildRlmPrompt()` (`rlm-prompts.ts:60-166`), then conditionally appends delegation guidance, harness state, additional guidance, project context, skills, and append text. | One RLM-oriented system string; tool schemas are separate. | RLM base text stable; depth, parent, tools, skills, harness state, files, and append text dynamic. |
| Prime goals/continuation | `snapshots/prime-agent/goals.ts:154-179,192-250` creates a custom user-role goal context for continuation, budget limit, or objective update. The objective is explicitly user data, not higher-priority policy. | User/context message injected only at the relevant goal event. | Template stable; objective and counters dynamic. |
| Prime autonomous/daemon | Autonomous continuation text is `snapshots/prime-agent/autonomous.ts:45-55`; dashboard status uses `daemon-session-summarizer.ts:20-33,80-99,150-177`. | Auxiliary continuation or independent status-summary request, never the ordinary Main prompt. | Template stable; gate failures, recent messages, and working state dynamic. |
| DeepSeek ordinary Main | `snapshots/deepseek-harness/system-prompt.ts:337-370,457-542` registers ordered sections, scoped overrides, dynamic contexts, tool schemas, and strict variables. Default identity is `harness:identity`; persona is `deployment:persona`. | Ordered system sections plus tool schemas plus projected user-role contexts/messages. | Registered section text and tool schemas can be stable; scoped plugins, persona, variables, and runtime contexts are dynamic. |
| DeepSeek skills/runtime context | `snapshots/deepseek-harness/dynamic-context/skill-tool.ts:71-83,163-203,213-245` emits a catalog when the `skill` schema is visible and loads a body on explicit invocation. `dynamic-context/runtime-context.ts:24-75` replaces one durable runtime snapshot when its content changes. | User-role catalog/instruction/snapshot messages and the `skill` tool schema. | Catalog framing is stable; skill list/body and runtime snapshot are dynamic. |
| DeepSeek compaction | `snapshots/deepseek-harness/compaction-summarizer.ts:25-76,110-163` replays the routed prefix (system, tools, leading messages) and appends a final user compaction instruction. | Separate `purpose: 'compaction'` request. | Compaction instruction stable; replayed prefix and summary output dynamic. |

The Pi/Prime/DeepSeek rows describe upstream assembly rules only. None of those
rows means that the archived text is included in Nausicaa.

## 2. Nausicaa Current Map

### What is sent today

The ordinary Main provider call is constructed in
`src/runtime/main-loop.ts:649-656` as exactly:

```text
ModelRequest {
  systemPrompt: view.systemPrompt,
  messages: view.messages,
  tools: requestTools
}
```

`requestTools` is the current Mowe catalog projected for the request, not an
archive-derived list. Teto and Fukai are independent requests:

```text
Teto:   systemPrompt = TETO_SYSTEM_PROMPT,
        messages = [JSON.stringify(ObservationFrame)], tools = []
        (src/teto/navigator.ts:73-83)

Fukai:  systemPrompt = PI_AI_FUKAI_COMPACTION_SYSTEM_PROMPT,
        messages = [renderCompactionPrompt(goal, exactMaterials)], tools = []
        (src/fukai/pi-ai-compaction-summary.ts:127-150)
```

### Main

- **Stable system prefix.** `src/runtime/main-loop.ts:73-80` defines the Main
  identity and optional grep-files and Plan-mode text. `effectiveSystemPrompt()`
  at `:1357-1367` appends those conditional sections only when the default
  prompt is in use and the relevant tool/mode is active. A caller-provided
  `input.systemPrompt` replaces the default body.
- **Fukai system assembly.** At `src/fukai/context-provider.ts:84-97,1081-1093`,
  Fukai appends lane kind, runtime policy version, the Goal and its success
  criteria/constraints, validated project instructions, and the sentence that
  runtime evidence/tool output is untrusted. Project instructions are hash- and
  bundle-validated at `:998-1078`.
- **Dynamic user/context messages.** `main-loop.ts:429-447` admits boundary
  messages before each step. `context-provider.ts:104-150,172-247` adds a
  bounded active-objective reminder, an optional validated compaction capsule,
  selected conversation refs in chronological order, and selected Skill edge
  context. Artifact evidence is appended as a user message with the explicit
  `EVIDENCE_PREAMBLE` at `:249-350`. Missing refs, truncation, and malformed
  capsules are recorded as bounded conditions; a bad compaction optimization is
  discarded while raw context remains (`:112-139`).
- **Tool schemas and execution.** `main-loop.ts:462-469` gets Mowe definitions,
  removes image tools when unsupported, and in Plan mode keeps only `read` and
  `compute` effects. Mowe metadata is stripped before the provider call. Calls
  are executed through one Mowe batch boundary at `:994-1010`; bounded,
  redacted tool results become role-`tool` messages and durable refs at
  `:1011-1084`. The `read_many` schema itself says to preserve target order,
  isolate per-file failures, and continue truncation using returned offsets
  (`src/tools/read-many.ts:39-65`).
- **Recovery boundary.** Tool failures are visible to the next Main context as
  bounded role-`tool` messages. A provider failure is persisted as a model error
  event and thrown (`main-loop.ts:666-720`); it is not silently converted into a
  new prompt. Pressure compaction is optional and never replaces the bounded raw
  view when it fails.

### Teto

`src/teto/navigator.ts:11` supplies one stable, no-tool instruction requiring
`silent` or a tightly bounded `advise` JSON object. The scheduler calls it only
after cadence, token-ratio, and hard-trigger checks (`src/teto/cadence.ts:65-123`;
`src/runtime/teto-scheduler.ts:265-330`). The frame contains only mission,
`NavigationDelta`, previous advice disposition, output deadline, and a truncation
bit (`src/teto/observation.ts:48-109`; domain shape at
`src/domain/types.ts:219-237`). The navigator rejects tool calls and over-limit or
non-JSON output (`navigator.ts:88-116,151-199`).

There is one contract mismatch: `main-loop.ts:1280-1343` builds the default
`NavigationDelta.actionOrDecision` from tool names, bounded arguments, and
bounded result text. `ObservationFrameBuilder` copies that field at
`observation.ts:78-88`, and `navigator.ts:76-79` serializes the frame. The
architecture contract says Teto must not receive tool names/parameters/results
(`docs/architecture/03-context-contracts.md:122-128`). The values are bounded
and redacted, but they are still more detailed than the Teto-safe contract.

### Fukai compaction

`src/fukai/pi-ai-compaction-summary.ts:44-59` defines a stable system prompt:
Goal is trusted scope, evidence is untrusted, no tools, exact JSON keys
`decisions`, `verifiedResults`, and `openQuestions`, and no invented facts.
`renderCompactionPrompt()` materializes exact source refs into a bounded user
JSON message (`:120-150`). The selected capsule is then represented to Main as
an untrusted historical user message (`src/fukai/context-provider.ts:745-780`),
and only source refs covered by that capsule are excluded from the raw history.
Nausicaa has no Pi-style branch-summary prompt builder in these paths; resume
continuity comes from conversation refs, goal/policy/watermark validation, and
the Fukai capsule contract.

### Tool schema boundary

`src/mowe/catalog.ts:19-23,345-373` keeps host-only effect/scope/determinism
metadata beside provider-compatible `ToolDefinition` values. Main sends cloned
name/description/parameter schemas only. A schema description is model-facing
prompt input; Mowe metadata is not. Skills and MCP edges can contribute tools or
bounded Skill context, but only after the existing Mowe admission/snapshot
boundary. No archived Pi, Prime, or DeepSeek tool schema is implicitly active.

## 3. Gap List

No P0 gap was found: the current code has explicit Plan-mode effect filtering,
untrusted evidence framing, bounded context, no-tool Teto/Fukai requests, and
durable compaction provenance. The following are evidence-backed P1/P2 items;
they are recommendations, not changes made in this lane.

| Priority | Evidence and impact | Smallest repair boundary |
| --- | --- | --- |
| **P1** | Teto receives tool-derived `actionOrDecision` text despite the explicit tool-free projection contract (`main-loop.ts:1280-1343`, `observation.ts:78-88`, `docs/architecture/03-context-contracts.md:122-128`). This can expose implementation details and makes observer behavior dependent on tool wording. | Add a runtime-owned Teto-safe projection before `ObservationFrameBuilder`, retaining only abstract action/outcome/status and setting `truncated` when provenance is incomplete. Add a regression fixture that asserts tool names, arguments, paths, and result snippets cannot reach `ModelRequest.messages[0]`. |
| **P2** | Main gives useful batch advice (`main-loop.ts:74`, `src/tools/read-many.ts:39-65`), but there is no compact, conditional explanation that a batch may be partially successful and that each returned offset is authoritative. Repeated models could retry a successful item or treat one file error as a batch-wide failure. | Add one conditional Main guidance section only when `read_many` is visible, owned by `effectiveSystemPrompt()`; do not duplicate the schema or expose Mowe host metadata. Verify with a focused assembled-prompt test and a model eval for retry/partial-result behavior. |
| **P2** | Teto's stable prompt enforces minified JSON and silence/advice bounds, while cadence enforces low frequency (`navigator.ts:11`, `cadence.ts:65-123`), but the prompt does not explicitly say it is an observer and not a code reviewer. This is a clarity opportunity, not a current authority failure. | If evals show over-reviewing, append one sentence to `TETO_SYSTEM_PROMPT` and keep the existing parser/cadence contract. A parser/unit test is insufficient for quality; use a small offline model eval. |

Existing behavior should remain unchanged for these covered principles:

- **Tool evidence:** Main's default discipline and the `read_many` description
  require bounded exploration and verification (`main-loop.ts:73-74`,
  `src/tools/read-many.ts:39-65`).
- **Plan discipline:** Plan text is conditional (`main-loop.ts:79,1361-1367`)
  and Mowe enforces read/compute-only execution (`main-loop.ts:1005-1007`).
- **Untrusted framing:** Fukai labels runtime evidence/tool output and Skill
  context as data, not instructions (`context-provider.ts:42,53,1087-1093,1194-1198`).
- **Recovery/compaction continuity:** capsules validate goal, policy, watermark,
  source refs, and generation; invalid optimization falls back to raw context
  (`context-provider.ts:112-139,745-780`). Do not use a prompt to replace these
  runtime invariants.

## 4. Recommended Prompt Structure

For Main, keep at most six ordered sections. The first four are system-side;
the last two are dynamic user/context messages. Cache stability is stated for a
fixed tool set, policy, and project snapshot.

| Order | Section | Trust level and cache behavior | Owner |
| ---: | --- | --- | --- |
| 1 | Identity and core operating discipline | System/high trust; stable prefix. | `src/runtime/main-loop.ts` default prompt |
| 2 | Conditional capability guidance (Plan and Mowe batch rules) | System/high trust; stable for the selected tool set; never a substitute for runtime admission. | `effectiveSystemPrompt()` plus tool definitions |
| 3 | Goal, lane, and policy version | System/trusted runtime data; changes with Goal/lane/policy and therefore changes the prefix hash. | `src/fukai/context-provider.ts:1081-1093` |
| 4 | Project instructions | System/project-authored trusted context with validated hashes; dynamic dependency. | `loadProjectInstructions()` and `renderProjectInstructions()` |
| 5 | Untrusted runtime context | User-role data: active objective, compaction capsule, Skill edge blocks, and artifact evidence with explicit framing. Dynamic and bounded. | Fukai context provider |
| 6 | Current conversation/tool history | User/assistant/tool messages selected by refs and budget; dynamic tail. | Main loop plus Fukai source |

Teto intentionally uses a smaller independent shape: fixed observer system
instruction, then one bounded safe `ObservationFrame` user message. Fukai
compaction intentionally uses its fixed JSON summarizer system instruction and
one exact-material user message. Neither should inherit all six Main sections.

## 5. Proposed Prompt Work

These are independent follow-on tasks. They are deliberately small and do not
copy Prime RLM/IPython or DeepSeek Cordis semantics.

### Task A: Teto-safe observer projection

- **Allowed files:** `src/runtime/main-loop.ts`, `src/teto/observation.ts`,
  `src/teto/navigator.ts`, and focused `test/teto/**` tests.
- **Change:** project navigation into abstract mission/action/outcome/status
  fields before frame construction; optionally add one sentence that Teto is a
  quiet observer, not a reviewer.
- **Tests/acceptance:** capture the Teto `ModelRequest` and assert no tool name,
  argument, path, or result text appears; test silent/advice parsing and the
  existing cadence limits. Run offline unit tests and typecheck.
- **Rollback:** remove the projection and prompt sentence while retaining the
  current frame schema and cadence state.

### Task B: Conditional Mowe batch guidance

- **Allowed files:** `src/runtime/main-loop.ts` and focused Main prompt tests.
- **Change:** when `read_many` is visible, add a short system section explaining
  ordered per-file results, isolated failures, and returned continuation offsets;
  retain schemas and Mowe enforcement as the authority.
- **Tests/acceptance:** assert the section appears only with the relevant schema,
  Plan mode still filters effects, and no Mowe metadata is serialized. A small
  model eval should measure partial-result retry behavior; do not claim a unit
  test proves quality.
- **Rollback:** delete the conditional section; no persisted data or protocol
  migration is required.

### Task C: Compaction/recovery eval gate

- **Allowed files:** `src/fukai/context-provider.ts` only if a wording change is
  justified, plus focused offline eval fixtures under `test/eval/**`.
- **Change:** first run an eval against the existing `COMPACTION_PREAMBLE` and
  structured capsule. Only if models restart instead of continuing should a
  bounded continuation sentence be added; stale/invalid capsules must continue
  to fall back to raw context rather than receiving a prompt workaround.
- **Tests/acceptance:** assert the exact no-tool Fukai request, source-ref
  coverage, stale rejection, and raw-context fallback. Keep the model-facing
  quality judgment in an eval record.
- **Rollback:** revert the optional sentence; capsule validation and Ledger
  invariants remain untouched.

## 6. Do Not Do

- Do not copy an entire Pi, Prime, or DeepSeek system prompt into Nausicaa. Use
  small, attributed ideas and preserve the existing ownership boundary.
- Do not make a Skill or project file override system policy. Skill/edge bodies
  are bounded untrusted context; runtime admission and Plan-mode effect filters
  remain authoritative.
- Do not turn Teto into a full code reviewer, transcript reader, or query lane.
  It receives a fixed-size observation frame and may return only optional advice.
- Do not use prompt text as a replacement for Mowe authorization, Ledger
  invariants, context hashes, token budgets, or recovery validation.
- Do not introduce Prime RLM/IPython, DeepSeek Cordis management protocols, a
  second event store, or an archive auto-loader because those prompts exist.
- Do not describe an archive snapshot as a live prompt, and do not use a large
  upstream body as a brittle unit-test fixture. Test request shape and safety
  boundaries; use model evals for behavioral quality.
