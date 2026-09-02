# Public Harness Benchmarks

This is the public testing contract for the Nausicaa beta. It keeps model
quality, tool behavior, provider compatibility, and daemon protocols as separate
measurements so one result cannot hide another.

## Required artifact fields

Each live batch records only bounded metadata:

- model selector and execution revision;
- selected case ids and manifest/scorer hashes;
- request count, token totals, cost when the provider supplied it, and elapsed time;
- tools and read paths observed by the grader;
- per-case status, completion state, and stable failure code.
- independent behavioral and answer-format outcomes for each graded case.

Prompts, full model responses, local absolute paths, and account material do not
belong in a public artifact.

## Score dimensions

For every workflow task, report these independently:

1. `worldState`: did the required file, session, lane, or protocol state exist?
2. `toolTrace`: were the required structured calls made and did their results succeed?
3. `answerFormat`: did the final response satisfy the task's requested format?
4. `boundary`: did the run stay inside its fixture and capability boundary?
5. `providerHealth`: were usage and settlement data complete and attributable?

A formatting miss must not erase a successful world-state result. Conversely, a
polished sentence must not pass when the required state change never happened.
The artifact keeps both `behavioralPassed` and `formatPassed`; the aggregate
`passed` flag remains strict and is true only when both are true.

## Recommended run shapes

| Run | Purpose | Selection |
| --- | --- | --- |
| Offline gate | Deterministic runtime and tool contracts | `npm run check` |
| Small provider smoke | One or two low-cost workflow tasks | Explicit case ids, a small request ceiling |
| Full beta capability batch | Portable Pi/Prime/DeepSeek task set | `NAUSICAA_BETA_CASES=all`, shared global ceiling |
| Provider matrix | Streaming, images, cache, token and error mapping | Separate adapter suite; do not merge into capability score |
| Daemon/A2A check | Attach, recovery, awareness topology, and lane messages | Protocol suite with a dedicated artifact |

Do not compare scores from different task sets, models, or provider modes. The
catalog manifest identifies the exact task set and scorer revision for each run.

## Live selection

The beta runner requires an explicit live opt-in, an exact model selector, a
positive budget, a request ceiling, and a clean execution revision. It supports
`NAUSICAA_BETA_CASES=all` or a comma-separated case list. The current beta
defaults are 100 requests per batch and 10,200 maximum output tokens per request;
the environment may choose a smaller ceiling.

The provider key is read from the current process only. It is never copied into
the artifact or repository. A request with incomplete usage is marked uncertain
and stops later cases so the report cannot claim a zero-cost result.

## Interpreting results

- `pass` means every assertion for that case passed.
- `fail` means at least one assertion failed; inspect the stable failure code and
  the bounded trace fields.
- `not-run-budget` means the shared meter stopped before that case. It is not a
  model failure.
- `provider-live` failures indicate adapter/account/model conditions unless the
  same behavior reproduces with a deterministic transport.
- `protocol-ui-only` results do not establish tool or coding capability.
