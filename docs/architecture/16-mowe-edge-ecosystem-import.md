# Mowe Edge Ecosystem Import

状态：Proposal。本文是 [`05-plugins-execution.md`](05-plugins-execution.md)
的聚焦补充；不引入新的 plugin runtime、marketplace 或事实源。

## Boundary

Mowe owns one execution contract: catalog admission, effect/scope grants,
bounded execution, result projection and Turn-local snapshots. An edge adapter
owns source-specific discovery and transport. A Skill contributes untrusted
context only; an MCP server contributes declared tools through the same
manifest/grant path. A future plugin descriptor may group those declarations,
but it is not executable code by itself.

```text
manual source declaration
  -> adapter discovery (metadata/schema)
  -> manifest/provenance validation
  -> host grant and deterministic collision checks
  -> immutable generation snapshot
  -> Mowe execution or explicit Skill context load
  -> release/disable; Ledger remains the sole fact source
```

## Beta policy

- Accept local `SKILL.md` roots and explicit MCP stdio/HTTP declarations only.
- Keep Skill body loading progressive, bounded and visibly untrusted.
- Treat MCP annotations as hints; authorization is host-owned.
- Keep plugin source type declarative/disabled until trust, dependencies,
  updates, rollback and removal are specified.
- Do not search/download/install marketplace packages or run arbitrary extension
  code in-process.

The detailed interoperability matrix, upstream evidence, tool-shape guidance,
marketplace definition and acceptance contract live in
`.local/MOWE-EDGE-ECOSYSTEM-REPORT.md`.
