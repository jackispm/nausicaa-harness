# Contributing

Thanks for helping improve Nausicaa. The project is in beta, so changes should
be small, testable, and explicit about any contract they introduce.

## Development setup

Use Node.js `>=22.19.0`, then install the locked dependencies:

```bash
npm ci
```

Before opening a pull request, run the relevant checks. Runtime changes should
at least pass:

```bash
npm run typecheck
npm test
npm run build
```

Changes to the built CLI should also pass `npm run test:smoke`. Deterministic
evaluation cases run with `npm run eval`; live provider tests are opt-in and
must not be enabled in ordinary CI.

## Change guidelines

- Keep changes close to their owning module and preserve explicit capability
  boundaries.
- Add focused tests for observable behavior, failure paths, and recovery.
- Do not commit API keys, `.env` files, runtime state, logs, or generated
  artifacts.
- Avoid changing public command or event contracts without documenting the
  compatibility impact.
- Use concise imperative commit subjects and include verification commands in
  pull requests.
