# Upstream Live Audit Summary

Date: 2026-09-03

The prior audits found more upstream tests than the first Nausicaa smoke run
used. They fall into three groups rather than one large list.

## Findings

1. Pi contributes a compact set of portable model tasks and a much larger
   deterministic tool/session suite. The portable tasks are now represented in
   the beta catalog; deterministic assertions remain local tests.
2. Prime contributes useful session-tree, RPC, daemon, worker, and provider
   tests. Most model-backed coding-agent cases require an Anthropic account, so
   they were not silently substituted with another provider.
3. DeepSeek contributes additional headless workflow tasks for filesystem
   paths, workspace instructions, compaction, Worker delegation, and capability
   boundaries. These are now represented by five additional beta cases.
4. DeepSeek web record, ACP, E2B, search, and native adapter suites are real
   integration surfaces, but they are not portable Nausicaa coding questions.
5. Codex account and native protocol probes are reference material rather than
   provider-neutral task scores.

## Scope of the answer

The upstream projects do have additional real-provider tests. They are not all
additional agent tasks: many check a provider adapter, browser replay, RPC
framing, or a daemon lifecycle. The source inventories record each family and
why it is or is not portable. This distinction prevents a skipped account-gated
case from being reported as a harness defect.

## Nausicaa action

The beta runner now selects the full enabled catalog with `NAUSICAA_BETA_CASES=all`,
uses a shared 100-request ceiling, and permits up to 10,200 output tokens per
request. Offline checks cover the new graders and ledger evidence. A future live
artifact should report the selected model, case ids, status, usage, and stable
failure codes only.

Each graded case also reports `behavioralPassed` and `formatPassed` separately.
This preserves evidence that a model completed the file/tool work even when its
final sentence does not match an exact-output instruction; the strict aggregate
`passed` field remains available for release gates.

The next separate work items are daemon/A2A awareness tests, provider adapter
matrix checks, and optional live compaction/Worker quality probes. They should
not be folded into the core capability score until their corresponding runtime
contracts are public and deterministic.
