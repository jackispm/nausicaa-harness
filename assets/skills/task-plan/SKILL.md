---
name: task-plan
description: Turn a requested change and inspected context into a concrete implementation plan with affected files, verification steps, risks, and unresolved decisions. Planning only.
license: MIT
---

# Task Plan

Use the user's requirements and inspected context to produce a clear,
actionable implementation plan. Do not change files or execute the plan unless
the user separately asks for implementation. This Skill grants no additional
tool permissions or authority to publish changes.

Confirm the requested outcome and existing behavior before planning. When a
codebase map or earlier investigation is provided, verify the facts that the
plan depends on. Inspect missing context with read-only tools.

Keep the plan concrete and proportional to the task:

- Goal: one sentence describing the required observable outcome.
- Steps: a short ordered sequence, naming the owning files or functions and
  the behavior each step changes.
- Files: existing files to modify and any necessary new files, with their purpose.
- Verification: relevant tests and observable success conditions, including
  failure paths affected by the change.
- Risks and decisions: compatibility, permissions, dependencies, or missing
  user choices that could change the result.

Prefer existing patterns and dependencies. Distinguish required work from
optional follow-ups, and mark assumptions explicitly rather than inventing
interfaces or promising an unverified outcome.

Adapted from Prime Agent's `examples/extensions/subagent/agents/planner.md` at
`7787f07415d843b9a800f6a4720e0c739bd608e5`. Removed upstream tool/model bindings,
added verification, and retained the planning-only boundary.
Copyright (c) 2025 Mario Zechner; Copyright (c) 2026 Prime Intellect. See ../LICENSE.
