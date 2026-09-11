# Codex worker runtime verification

Recorded locally on 2026-09-11 for the storyboard-loop implementation. This is preparation evidence, not deployed-runtime or paid-execution evidence.

## Baseline

- Base commit: `586c494 fix(deploy): build core api production target`.
- Current branch: `codex/n8n-codex-rovelle-integration`; pre-existing plan, specification, helper, and unrelated working-tree changes were preserved.
- Baseline `git status --short`: modified `AGENTS.md` and `PROJECT_REVIEW.md`; untracked `.serena/`, `.superpowers/brainstorm/`, `assets/`, September 6/9/11 Rovelle plan/spec files, `tsconfig.build.tsbuildinfo`, and `workflows/`. Task 1 adds only this runtime record and its gitignored SDD ledger.
- `ROVELLE_TEST_DATABASE_URL` is unset. Database acceptance tests remain blocked until an explicitly verified disposable database is provided.
- TypeScript test compilation succeeded with `npx tsc -p tsconfig.test.json`.
- Existing creator and production suites passed: 13 files, 13 passing, 0 failures.
- Existing local creator transport fixture passed: 1 passing, 0 failures.

## Pinned SDK discovery

- Official SDK library: Context7 `/openai/codex`; official package documentation and package metadata were checked on 2026-09-11.
- Current package version discovered: `@openai/codex-sdk@0.154.0`.
- Bundled CLI/runtime package: `@openai/codex@0.154.0` with its `@openai/codex-linux-x64@0.154.0` platform package. Local verification runtime is Node.js `v24.16.0`; deployed base image/version remains Task 8 rollout evidence.
- Package engine: Node.js `>=18`; project target is Node.js-compatible CommonJS test output.
- Package is ESM-only: export map has `import` and types, without a CommonJS export. A temporary isolated install successfully ran `await import("@openai/codex-sdk")` and found `Codex`.
- A temporary `.mts` smoke compiled with `tsc --module NodeNext --moduleResolution NodeNext` and executed as ESM successfully. Implementation requires that worker-specific NodeNext/ESM boundary; do not migrate Core's CommonJS build.
- SDK `Thread.run` accepts `outputSchema` and `AbortSignal`; structured output and 480-second cancellation are supported. No SDK max-turn, retry, token-budget, or dollar-budget control exists.
- SDK exposes `sandboxMode`, `approvalPolicy`, `networkAccessEnabled`, `webSearchMode`, `workingDirectory`, and a non-inheriting environment map. OS/container isolation remains required; SDK settings alone are not sufficient.
- SDK type evidence: completed turns expose nullable `usage` with `input_tokens`, `cached_input_tokens`, `cache_write_input_tokens`, `output_tokens`, and `reasoning_output_tokens`; `turn.completed` carries same usage shape. Actual usage availability remains live-runtime evidence.

## Runtime release gaps

- `CODEX_CREATIVE_MODEL` is not yet configured. Worker config must reject a missing value; Task 9 must fail Core startup whenever creative mode is enabled without it. Task 7 may implement this contract, but it cannot prove deployed configuration.
- No live Codex execution occurred. Model availability, authentication, usage fields in a deployed worker, output retrieval, cancellation, and enforced tool/network isolation require separately authorized runtime evidence.
- No Codex package has been added to `package.json` yet. Task 7 owns the exact pin and import boundary after this evidence is reviewed.
- No n8n production graph was changed. Local n8n adapter work remains Task 10; workflow rollout stays Task 12.
