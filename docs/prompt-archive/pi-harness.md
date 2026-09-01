# Pi Harness Prompt Archive

## Provenance

- Repository: `/Users/gongdongjie/Downloads/pi`
- Remote: `https://github.com/earendil-works/pi.git`
- Commit: `1defa151e0c1dac87d38a2d0ac09d67f817b30f9`
- Version: `pi-monorepo@0.0.3`
- Collected: 2026-09-01
- Exact source snapshots: [`../reference-prompts/snapshots/pi`](../reference-prompts/snapshots/pi)

## Archive Boundary

This page describes the checked-in Pi source snapshot only. Nausicaa does not
load this Markdown file or the snapshot directory when constructing a request;
the live request must be traced through Nausicaa's `src/runtime` and `src/fukai`
code. Dynamic values below are upstream assembly inputs, not values automatically
copied into Nausicaa.

## Prompt Channels

Pi has four practical prompt channels:

1. The coding-agent system prompt assembled by `buildSystemPrompt()`.
2. Tool snippets and tool-specific guideline bullets.
3. Compaction/branch-summary requests and their `<summary>` message wrappers.
4. Prompt templates, skills, extension prompts, and provider-level fallback text.

## Default System Prompt

Source: [`coding-agent-system-prompt.ts`](../reference-prompts/snapshots/pi/coding-agent-system-prompt.ts), copied from `packages/coding-agent/src/core/system-prompt.ts`.

The default body begins:

```text
You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.
```

The builder then appends the visible tool list, tool-conditioned exploration guidelines, Pi documentation paths and reading rules, optional `appendSystemPrompt`, project instructions inside `<project_context>` and `<project_instructions path="...">`, visible skills inside `<available_skills>`, and `Current working directory: ...`. A custom prompt replaces the default body but retains context files, skills, cwd, and append text.

The generic agent package contributes the XML skill block in [`agent-system-prompt.ts`](../reference-prompts/snapshots/pi/agent-system-prompt.ts):

```text
The following skills provide specialized instructions for specific tasks.
Read the full skill file when the task matches its description.
When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.
```

## Tool Prompt Text

The exact snippets and guidelines are in [`tool-prompts/`](../reference-prompts/snapshots/pi/tool-prompts):

| Tool | Snippet | Main guidance |
| --- | --- | --- |
| `read` | `Read file contents` | Use `read` instead of `cat` or `sed`. |
| `write` | `Create or overwrite files` | Use only for new files or complete rewrites. |
| `edit` | Precise exact-text replacement | Match `oldText` exactly; merge nearby changes; do not overlap or pad edits. |
| `bash` | Execute bash commands | `PI_*` model/session variables are inspectable. |
| `powershell` | Execute PowerShell commands | Same `PI_*` guidance. |
| `grep` | Search file contents for patterns | Respects `.gitignore`. |
| `find` | Find files by glob pattern | Respects `.gitignore`. |
| `ls` | List directory contents | No extra prompt guidance. |

Tool schemas also carry model-facing descriptions and parameter descriptions; the copied source files are authoritative for the full text.

## Compaction And Branches

Sources: [`agent-compaction.ts`](../reference-prompts/snapshots/pi/agent-compaction.ts), [`coding-agent-compaction.ts`](../reference-prompts/snapshots/pi/coding-agent-compaction.ts), [`coding-agent-branch-summarization.ts`](../reference-prompts/snapshots/pi/coding-agent-branch-summarization.ts), and [`agent-messages.ts`](../reference-prompts/snapshots/pi/agent-messages.ts).

The summarizer system instruction is:

```text
You are a context summarization assistant. Your task is to read a conversation between a user and an AI assistant, then produce a structured summary following the exact format specified.

Do NOT continue the conversation. Do NOT respond to any questions in the conversation. ONLY output the structured summary.
```

The initial and update checkpoint prompts require, in order: `## Goal`, `## Constraints & Preferences`, `## Progress` with `### Done`, `### In Progress`, and `### Blocked`, `## Key Decisions`, `## Next Steps`, and `## Critical Context`. They require concise text and preservation of exact file paths, function names, and error messages. The update variant preserves still-valid prior information and merges new progress. A split-turn prefix uses `## Original Request`, `## Early Progress`, and `## Context for Suffix`.

Branch summaries start with:

```text
The user explored a different conversation branch before returning here.
Summary of that exploration:
```

They use Goal / Constraints & Preferences / Progress / Key Decisions / Next Steps and accept `Additional focus: ...`. Serialized input is wrapped in `<conversation>...</conversation>`. Reintroduced summaries use `<summary>...</summary>` wrappers.

## Templates And Skills

[`prompt-templates.ts`](../reference-prompts/snapshots/pi/prompt-templates.ts) and [`agent-prompt-templates.ts`](../reference-prompts/snapshots/pi/agent-prompt-templates.ts) define discovery from `~/.pi/agent/prompts`, project `.pi/prompts`, package/settings paths, and explicit CLI paths. Frontmatter supports `description` and `argument-hint`; expansion supports `$1`, `$2`, `$@`, `$ARGUMENTS`, and default/slice forms.

Repository-local templates are preserved verbatim in [`project-prompts/`](../reference-prompts/snapshots/pi/project-prompts):

- `cl.md`: changelog/release audit;
- `is.md`: GitHub issue investigation without implementation;
- `pr.md`: PR, issue, commit, diff, and documentation review;
- `sa.md`: Security Advisory/CVSS workflow with no unapproved PoC or publication;
- `wr.md`: end-to-end wrap-up, changelog, commit/push, and issue-closing workflow.

The local `add-llm-provider.md` skill is in [`project-skills/`](../reference-prompts/snapshots/pi/project-skills). Scout/planner/worker/reviewer prompts and orchestration templates are in [`subagent-prompts/`](../reference-prompts/snapshots/pi/subagent-prompts).

## Extension And Provider Prompts

Prompt examples are copied in [`examples/`](../reference-prompts/snapshots/pi/examples): handoff, Q&A extraction, custom compaction, plan mode, preset instructions, Claude rules, pirate mode, structured output, and tic-tac-toe. These are opt-in examples, not part of every default session.

Provider adapters may also add:

```text
You are Claude Code, Anthropic's official CLI for Claude.
```

for Anthropic OAuth requests, or use `You are a helpful assistant.` when an OpenAI Codex Responses request has no system prompt. Exact adapter behavior is in [`provider-anthropic-messages.ts`](../reference-prompts/snapshots/pi/provider-anthropic-messages.ts) and [`provider-openai-codex-responses.ts`](../reference-prompts/snapshots/pi/provider-openai-codex-responses.ts).

## Open Inputs

`SYSTEM.md`, `APPEND_SYSTEM.md`, project/global instruction files, installed skill bodies, user prompt templates, extension output, and tool results are runtime data. They are not fabricated in this archive; discovery and interpolation code is preserved in the snapshots.
