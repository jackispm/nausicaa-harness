---
name: code-review
description: Review code changes for substantiated correctness, lifecycle, security, and regression risks. Report prioritized findings with evidence; do not modify files.
license: MIT
---

# Code Review

Review the requested changes without modifying files. Establish the exact
comparison or working-tree scope first, then read the diff and enough surrounding
code to understand both sides of each changed contract. Follow the repository's
applicable instructions. Do not publish comments, run mutating commands, or
implement fixes merely because this Skill is active.

Prioritize correctness, lifecycle, security, and broken required behavior over
style. A short review with one substantiated blocker is better than a list of
nits. The following are investigation prompts, not a mandatory checklist:

- Trace changed interfaces through their real consumers, including errors,
  cancellation, ownership, and disposal.
- For asynchronous code, inspect publication races, cancellation across awaits,
  callback containment, and cleanup after partial initialization.
- Follow permission denials to the actual operation and check alternate callers.
- Verify limits against the complete emitted or retained result, including
  wrappers, metadata, multibyte text, and exact-limit cases.
- Check that configuration, defaults, documentation, and model-visible prompts
  agree with shipped behavior.
- Evaluate whether tests exercise the real entry path and fail for the intended
  regression. Passing tests do not prove the scenario is correct.
- Separate demonstrated defects from architectural preferences and speculative
  generality. Do not infer a bug solely because code looks complex.

For each finding, state the defect, precise file and line, triggering conditions,
impact, and evidence. Lead with findings ordered by severity; separate open
questions and verification gaps. If no defect was found, say so and name the
remaining limits of the review. Do not claim checks you did not run.

Adapted from DeepSeek Harness's `.agents/skills/dsh-code-review/SKILL.md` at
`b150a551b8d465e31e418e1b2eaf5e79bbb7d28e` and Pi's
`examples/extensions/subagent/agents/reviewer.md` at
`1defa151e0c1dac87d38a2d0ac09d67f817b30f9`. Removed repository-specific paths,
pnpm gates, Agent Notes, and tool/model bindings; retained evidence and review
boundaries. Copyright (c) 2026 DeepSeek; Copyright (c) 2025 Mario Zechner.
See ../LICENSE.
