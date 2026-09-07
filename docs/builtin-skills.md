# Bundled Skills

Nausicaa ships three data-only presets in `assets/skills`: `codebase-map`,
`task-plan`, and `code-review`. `/skills` can select them, and the model can load
their instructions with the ordinary `skill` tool. Discovery exposes only names
and descriptions. Presets do not execute code, select models, grant permissions,
or introduce an additional tool runtime.

## Reuse record

| Preset | Inspected upstream | Adopted boundary |
| --- | --- | --- |
| `codebase-map` | [Pi scout](https://github.com/earendil-works/pi/blob/1defa151e0c1dac87d38a2d0ac09d67f817b30f9/packages/coding-agent/examples/extensions/subagent/agents/scout.md) | Targeted exploration, exact file evidence, compact architecture handoff |
| `task-plan` | [Prime Agent planner](https://github.com/PrimeIntellect-ai/prime-agent/blob/7787f07415d843b9a800f6a4720e0c739bd608e5/packages/coding-agent/examples/extensions/subagent/agents/planner.md) | Read-only planning, concrete file changes, risks; local adaptation adds verification |
| `code-review` | [DeepSeek review](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/.agents/skills/dsh-code-review/SKILL.md) and [Pi reviewer](https://github.com/earendil-works/pi/blob/1defa151e0c1dac87d38a2d0ac09d67f817b30f9/packages/coding-agent/examples/extensions/subagent/agents/reviewer.md) | Evidence-first correctness, lifecycle, permission, and test review |

All three upstream snapshots are MIT-licensed. Copyright notices, exact source
revisions, and changes are recorded in each `SKILL.md`; the complete license is
shipped in `assets/skills/LICENSE`. These are attributed adaptations, not claims
that upstream ships identically named Skills. Pi/Prime agent frontmatter's model
and tool bindings are deliberately removed.

Prime's built-in `websearch` and `edit` Skills were inspected but not adopted:
they require Serper configuration or Prime's prepared IPython helpers. DeepSeek's
Cordis, pnpm, package-specific Agent Notes, and repository-local documentation
links are not portable and are omitted. No upstream scripts are bundled or run.

## Loading boundary

`createBundledSkillsEdgeAdapter` reuses the existing guarded Skill loader against
a fixed package-relative directory. `src/` and the npm package's `dist/` resolve
the same `assets/skills` location. The workspace loader's no-follow reads, size
limits, content identity, and path restrictions are unchanged.

The CLI supplies currently discovered user/project names through
`getOverrideNames`; same-name bundled presets are fallback-only. Refresh other
Skill sources before refreshing the bundled source to make precedence current.
Already captured snapshots retain the same two-generation load window as the
underlying adapter. `--no-edges` disables bundled discovery alongside local
discovery; explicit Skill sources do not silently remove the remaining presets.

The existing npm `files` allowlist includes `assets`, so installed CLIs receive
these presets without a source checkout or copying files into a user's project.
