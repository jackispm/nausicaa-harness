# Harness Prompt Reference

This directory is a point-in-time, read-only harvest of model-facing prompts from the three local reference harnesses. The files under `snapshots/` are copied source files, not rewritten prompt variants. Use the catalog for the intent and trigger, then open the snapshot for the exact template and interpolation rules.

It lives under a repository-local `docs/` working-material tree. New working material is ignored, and the npm package allow-list excludes the entire tree; selected archive pages may be force-added for review evidence, so a tracked page still never enters the runtime import graph.

## 先记住：归档不是运行时 Prompt

本目录**不会**被 Nausicaa 自动读取，也不会因为文件名包含 `system-prompt` 就发送给模型。
这里的文件是我们从 Pi、Prime Agent 和 DeepSeek Harness 复制的研究快照，作用是阅读、比较和
追踪上游变化。它们位于 `docs/reference-prompts/`，不在 `src/` 的运行时导入图中；新增的
`docs/` 工作材料由本仓库的 `.gitignore` 排除，少数为证据保留的归档页即使被跟踪也不会进入
运行时。`docs/prompt-archive/` 当前包含简短的整理页和生成的上游工具目录；
这些同样属于归档材料，不是运行时资源。

模型真正收到的是**运行时按当前状态组装的一次请求**，通常由下面几部分组成：

```text
effective system prompt
  + 当前 Turn 实际开放的 tool schemas/descriptions
  + 当前有效的 conversation/context messages
  + （仅在需要时）选中的 Skill、artifact 片段、compaction capsule 或 lane 输入
```

每次 Main 请求都会重新计算有效的 system prompt、工具集合和消息视图，但这不等于把本目录的
所有 Markdown 或所有历史全文塞回模型。未启用的工具、未选择的 Skill 和不属于当前 lane 的
上下文不会进入请求；稳定前缀可以保持缓存亲和。Teto 和 Fukai 摘要 provider 各自有独立的
model request，不能把它们的提示词误认为 Main 每轮都会附带的文本。统一 Teto lane 仍通过
同一个 MainLoop/Fukai contract 组装请求，只是它的 system prompt、工具集合和 Main public
projection 不同。

### 文件、用途和发送时机

| 文件/目录 | 是什么 | 是否每轮发送 |
| --- | --- | --- |
| `snapshots/pi/**` | Pi 上游源码快照，含 prompt builder、工具说明、compaction 和示例 | 否；仅研究资料 |
| `snapshots/prime-agent/**` | Prime 上游源码快照，含 RLM、daemon、goal、subagent 等 prompt builder | 否；仅研究资料 |
| `snapshots/deepseek-harness/**` | DeepSeek 上游 section registry、工具 section 和动态 context 快照 | 否；仅研究资料 |
| `docs/prompt-archive/*.md` | 对快照的来源、顺序和触发条件的整理页及生成工具目录 | 否；仅研究资料 |
| `catalog.txt` | 本归档的文件索引 | 否 |
| Nausicaa `src/runtime/main-loop.ts` / `src/fukai/context-provider.ts` | Nausicaa 自己的运行时 prompt/context 组装代码 | 会影响实际请求 |
| 当前 `AgentTool.definition` | 当前 Turn 的工具 schema 和说明 | 只发送本轮允许的工具 |
| `src/runtime/teto-lane-scheduler.ts` | 统一 Teto lane 的 system prompt 和 activation 入口 | 每个公开 Main event 最多一次 |
| `src/runtime/main-public-projection.ts` | 用户输入、Main 输出和工具请求的脱敏投影 | 在 Teto activation 前编译 |
| `src/teto/navigator.ts` | 旧 sparse observer prompt | 仅在 legacy `maxMainSteps` replay 路径发送 |
| `src/fukai/pi-ai-compaction-summary.ts` | Fukai 摘要 provider prompt | 仅在显式启用且压力门触发时发送 |

因此，“Pi 的 system prompt 在一个文件里”“DeepSeek 没有单一 prompt 文件”描述的是**上游
源码的组织方式**，不是说那些研究文件会被 Nausicaa 运行时加载。要知道某次请求的实际内容，
应查看对应的运行时组装函数和事件中的脱敏 `ContextManifest`，而不是把归档文件拼接起来。

The companion audit at
`.local/PROMPT-ARCHIVE-AND-NAUSICAA-PROMPT-REVIEW-REPORT.md` is the live-behavior
map. It cites Nausicaa source separately from these snapshots and does not treat
archived prompt text as an expected request fixture.

## Sources

| Harness | Local checkout | Version | Commit | Snapshot |
| --- | --- | --- | --- | --- |
| Pi | `/Users/gongdongjie/Downloads/pi` | `pi-monorepo@0.0.3` | `1defa151e0c1dac87d38a2d0ac09d67f817b30f9` | [pi](snapshots/pi) |
| Prime Agent | `/Users/gongdongjie/Downloads/primeagent` | `prime-agent@0.7.2` | `7787f07415d843b9a800f6a4720e0c739bd608e5` | [prime-agent](snapshots/prime-agent) |
| DeepSeek Harness | `/Users/gongdongjie/Downloads/deepseek-harness` | `@deepseek-ai/dsh-root@0.1.1-rc.2` | `b150a551b8d465e31e418e1b2eaf5e79bbb7d28e` | [deepseek-harness](snapshots/deepseek-harness) |

The snapshots were copied on 2026-09-01. They retain the original source comments and line structure so `rg` can be used to find every `PROMPT`, `INSTRUCTION`, prompt section, and model-facing tool description.

## Comparison

| Concern | Pi | Prime Agent | DeepSeek Harness |
| --- | --- | --- | --- |
| Base identity | Coding-assistant prose with visible tools and Pi docs | RLM/IPython operating contract | Ordered identity/persona sections; deployment owns persona |
| Prompt composition | One string builder plus append/context/skills | RLM builder plus delegation, harness state, context, skills, append | Registry of sections, contexts, tools, variables, and waterfall transforms |
| Compaction | Standalone summarizer system prompt and structured checkpoint | Same checkpoint contract, plus goals/autonomy/refine around it | Replays routed prefix, then appends compaction instruction as the final user message for cache reuse |
| Delegation | Extension-level subagent templates | Native `rlm(...)`, messaging, observation, and child doctrine | Tool-driven fresh/fork/continuable subagents, reports, workflows, and optional Agent Teams |
| Extensibility | `SYSTEM.md`, `APPEND_SYSTEM.md`, prompt templates, extensions | Same plus continual harness memories/skills/subagent specs | Scoped section/context/tool/variable registration, dynamic Cordis plugins, and runtime policy contexts |
| Strongest reusable idea | Small, inspectable default prompt with explicit tool guidelines | Persistent control kernel and evidence-backed delegation/refinement | Ordered prompt registry with explicit provenance and injection-resistant runtime context |

For Nausicaa, the most compatible pieces are the explicit prompt assembly order, structured compaction sections, untrusted framing for injected context, and a clear distinction between base identity, tool guidance, runtime context, and user/deployment data.

## Catalog

### Pi

Pi's default coding-agent prompt is assembled by [`coding-agent-system-prompt.ts`](snapshots/pi/coding-agent-system-prompt.ts). The default body starts with:

> You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.

The builder then adds, in order: visible tool snippets, tool-conditioned guidelines, Pi documentation paths and reading rules, `appendSystemPrompt`, `<project_context>` blocks, visible skills as `<available_skills>`, and the current working directory. A custom system prompt replaces the default body but still receives context files, skills, cwd, and append text. The generic agent-side skill formatter is in [`agent-system-prompt.ts`](snapshots/pi/agent-system-prompt.ts).

Prompt-bearing Pi files:

- [`coding-agent-system-prompt.ts`](snapshots/pi/coding-agent-system-prompt.ts): default system prompt and assembly order.
- [`agent-system-prompt.ts`](snapshots/pi/agent-system-prompt.ts): XML skill catalog and relative-path rule.
- [`tool-prompts/`](snapshots/pi/tool-prompts): read/write/edit/bash/powershell/grep/find/ls snippets and guidelines.
- [`coding-agent-compaction.ts`](snapshots/pi/coding-agent-compaction.ts), [`coding-agent-compaction-utils.ts`](snapshots/pi/coding-agent-compaction-utils.ts), [`agent-compaction.ts`](snapshots/pi/agent-compaction.ts): summarization system prompt, initial/update checkpoint prompts, turn-prefix prompt, serialization, and file-operation metadata.
- [`coding-agent-branch-summarization.ts`](snapshots/pi/coding-agent-branch-summarization.ts), [`agent-branch-summarization.ts`](snapshots/pi/agent-branch-summarization.ts): branch-summary prompt and additional-focus handling.
- [`agent-messages.ts`](snapshots/pi/agent-messages.ts): `<summary>` wrappers used when compacted or branched history is reintroduced.
- [`prompt-templates.ts`](snapshots/pi/prompt-templates.ts), [`agent-prompt-templates.ts`](snapshots/pi/agent-prompt-templates.ts): template discovery, frontmatter, and `$1`/`$@`/`$ARGUMENTS` expansion.
- [`project-prompts/`](snapshots/pi/project-prompts): repository-local `/cl`, `/is`, `/pr`, `/sa`, and `/wr` workflow templates.
- [`project-skills/`](snapshots/pi/project-skills): repository-local `add-llm-provider.md` skill prompt.
- [`subagent-prompts/`](snapshots/pi/subagent-prompts): scout/planner/worker/reviewer agent prompts and implement/scout-and-plan orchestration templates.
- [`examples/`](snapshots/pi/examples): handoff, Q&A extraction, custom compaction, plan mode, presets, Claude rules, pirate mode, structured output, and tic-tac-toe examples.
- [`provider-anthropic-messages.ts`](snapshots/pi/provider-anthropic-messages.ts), [`provider-openai-codex-responses.ts`](snapshots/pi/provider-openai-codex-responses.ts): provider-level Claude identity and helpful-assistant fallback strings.

The compaction prompts use a standalone summarizer system instruction: `You are a context summarization assistant... Do NOT continue the conversation... ONLY output the structured summary.` The required sections are `Goal`, `Constraints & Preferences`, `Progress` (Done/In Progress/Blocked), `Key Decisions`, `Next Steps`, and `Critical Context`; exact paths, function names, and error messages are preserved. Branch summaries use the same core structure with a branch preamble. Tool-result serialization is bounded before it is wrapped in `<conversation>`.

### Prime Agent

Prime Agent keeps the Pi compaction model but replaces the default coding-agent body with an RLM/IPython operating prompt. The assembly entry point is [`coding-agent-system-prompt.ts`](snapshots/prime-agent/coding-agent-system-prompt.ts); its base prompt is [`rlm-prompts.ts`](snapshots/prime-agent/rlm-prompts.ts). The base prompt covers persistent IPython state, `%%bash` rules, native project environments, installed Python skills, continual harness CRUD, native `rlm(...)` child admission, agent messaging/observation, and when to delegate. [`prompts-index.ts`](snapshots/prime-agent/prompts-index.ts) exposes the same builders.

Additional Prime Agent prompt families:

- [`compaction.ts`](snapshots/prime-agent/compaction.ts), [`compaction-utils.ts`](snapshots/prime-agent/compaction-utils.ts), [`branch-summarization.ts`](snapshots/prime-agent/branch-summarization.ts): initial/update/turn-prefix/branch summaries and compaction framing.
- [`messages.ts`](snapshots/prime-agent/messages.ts): compacted and branch-summary message wrappers, plus heartbeat message metadata.
- [`goals.ts`](snapshots/prime-agent/goals.ts): continuation, budget-limit, objective-updated, and completion-budget prompts. Objectives are explicitly treated as user data, not higher-priority instructions.
- [`autonomous.ts`](snapshots/prime-agent/autonomous.ts): autonomous continuation and gate-failure continuation prompts.
- [`side-question.ts`](snapshots/prime-agent/side-question.ts): no-tools side-question instruction.
- [`refinement.ts`](snapshots/prime-agent/refinement.ts): `/refine` system prompt and automatic review gate for memories, skills, prompt notes, and reusable subagent specs.
- [`daemon-session-summarizer.ts`](snapshots/prime-agent/daemon-session-summarizer.ts): dashboard status-line prompt and its `COMPLETED`/`NEEDS_INPUT` contract.
- [`package-manager-cli.ts`](snapshots/prime-agent/package-manager-cli.ts): update/restart continuation prompt used when a package operation replaces the running process.
- [`subagent-prompts/`](snapshots/prime-agent/subagent-prompts): scout/planner/worker/reviewer and orchestration templates.
- [`examples/`](snapshots/prime-agent/examples): handoff, Q&A, custom compaction, plan mode, preset instructions, structured output, Claude rules, pirate mode, and tic-tac-toe prompts.

Prime-specific ordering is significant: `buildRlmPrompt()` comes first, delegation guidance is appended next, harness state/refinement menus follow, then additional guidance, project context, skills, append text, and (for custom prompts) date/cwd plus child doctrine. This means copying only the final system string without its active-tool and skill inputs loses behavior.

### DeepSeek Harness

DeepSeek separates prompt assembly into ordered sections, dynamic contexts, tool schemas, and interpolated variables. The registry is [`system-prompt.ts`](snapshots/deepseek-harness/system-prompt.ts): by default it contributes `harness:identity` (`You are an AI agent powered by DeepSeek Harness.`) and `deployment:persona`, then merges scoped overrides, runtime contexts, tools, and `{{provider}}`/`{{model}}`/`{{cwd}}` variables. A complete scoped section replaces the assembled sections.

The companion [DeepSeek prompt archive](../prompt-archive/deepseek-harness.md) contains the ordered section table and exact rendered text for the main static and dynamic channels. The snapshots below preserve the source implementations behind that archive.

Stable system and tool sections are captured in:

- [`system-sections/`](snapshots/deepseek-harness/system-sections): system registry, agent-loop variables, app-boot source checkout notice, and Web GUI context.
- [`tool-sections/`](snapshots/deepseek-harness/tool-sections): filesystem read/write/edit/search, bash/PowerShell, jobs, terminal, web search/fetch, LSP, session query, goal, workflow/Ralph, subagent/report, and Agent Teams guidance. Tool `description` and parameter descriptions are also model-facing prompt text.
- [`cordis-prompt.ts`](snapshots/deepseek-harness/cordis-prompt.ts): the complete Dynamic Cordis Plugin workflow, lifecycle, Host/Client, approval, and repair prompt.
- [`code-mode.ts`](snapshots/deepseek-harness/code-mode.ts), [`typescript-code-mode.ts`](snapshots/deepseek-harness/typescript-code-mode.ts), and [`python-code-mode.ts`](snapshots/deepseek-harness/python-code-mode.ts): `run_code` descriptions, mode rules, and generated SDK instructions.
- [`subagent-structured.ts`](snapshots/deepseek-harness/subagent-structured.ts): terminating `structured_output` instruction.

The repository already contains a generated, exhaustive default tool-schema dump at [`../prompt-archive/deepseek-tool-catalog.md`](../prompt-archive/deepseek-tool-catalog.md). Use it alongside these source snapshots when the exact `description` or JSON-Schema parameter wording matters.

Dynamic and injected model context is captured in [`dynamic-context/`](snapshots/deepseek-harness/dynamic-context):

- workspace `AGENTS.md`/`CLAUDE.md` rendering, replacement/truncation markers, and `<system-reminder>` framing;
- `@` file-reference guidance and untrusted cross-session JSON wrappers;
- runtime sandbox, time, tmux, and cleared-runtime-context snapshots;
- skill catalog/content messages, repeat-tool reminders, goal-round and goal-wrapup messages;
- scheduled reminders, subagent settlement/relay notices, approval-disabled notices, and file-deliverable response guidance.

The compaction engine is [`compaction-summarizer.ts`](snapshots/deepseek-harness/compaction-summarizer.ts). Unlike Pi/Prime, it replays the routed conversation prefix and appends a final user message beginning `You are now acting as a compaction engine...`; the exact eight-section checkpoint format is in that file. `frameSummary()` wraps the text in `<compacted-summary>` with a checkpoint preamble.

## What "all" means here

This harvest includes finite, repository-owned model-facing prompt literals and the source functions that assemble them. It intentionally does not invent values for open-ended inputs:

- user/deployment persona text, `SYSTEM.md`, `APPEND_SYSTEM.md`, project `AGENTS.md`/`CLAUDE.md`, installed skills, prompt templates, and dynamic plugin source are data supplied at runtime;
- every registered tool schema description/parameter description is prompt input. The DeepSeek tool-section snapshots preserve the owning modules, while the generated [tool-schema catalog](../prompt-archive/deepseek-tool-catalog.md) provides the flattened default composition;
- provider adapters may add identity/fallback instructions, and hooks/tool results may inject runtime user messages;
- test snapshot files are evidence of assembled prompts, not additional production prompt definitions.

To audit or refresh the harvest, compare the source commit table above, run `rg -n 'PROMPT|INSTRUCTION|systemPrompt|promptGuidelines|description:' snapshots`, and copy any newly introduced prompt-bearing module into the corresponding snapshot directory. Do not edit snapshots by hand when evaluating a design change; keep proposed Nausicaa prompts in a separate source file.
