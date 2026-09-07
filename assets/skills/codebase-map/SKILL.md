---
name: codebase-map
description: Investigate a codebase or subsystem and return a concise, evidence-backed map of its purpose, entry points, contracts, and relevant tests.
license: MIT
---

# Codebase Map

Quickly investigate the requested codebase or subsystem and return structured
findings that another person or agent can use without rereading everything.
Use read-only inspection; this Skill does not authorize changes.

Infer the depth from the task: targeted lookups for a quick question, imports and
critical sections for a normal investigation, dependencies and tests for a
thorough audit. Do not expand a narrow request into a whole-repository survey.

1. Locate entry points and relevant code with the available file-search tools.
2. Read key sections and their actual callers. Use the README as an orientation,
   then verify claims against source and configuration.
3. Identify important types, interfaces, functions, and ownership boundaries.
4. Follow dependencies far enough to explain how the requested behavior works.
5. Identify tests that support the explanation and gaps you could not verify.

Report the relevant files with precise paths and line references, the essential
contracts, how the pieces connect, and where to start next. Include small actual
code excerpts only when they clarify a contract. Distinguish inspected facts
from inferences and unverified behavior.

Adapted from Pi's `examples/extensions/subagent/agents/scout.md` at
`1defa151e0c1dac87d38a2d0ac09d67f817b30f9`. Removed upstream tool/model bindings and
made read-only scope explicit. Copyright (c) 2025 Mario Zechner. See ../LICENSE.
