# Final review fix report

## Scope

Applied the four findings from `final-fix-brief.md` on
`codex/LLM-integration-with-SDK` at fix base `ed11b8d`.

- Forced the OpenAI SDK client to `logLevel: "off"`.
- Added one native `AbortSignal.timeout(OPENAI_TIMEOUT_MS)` to the Responses
  request and raced the SDK promise against that same overall deadline.
- Added direct model-produced reset coverage proving cancellation, state reset,
  and no SQL.
- Added direct syntactically invalid JSON (`"{"`) coverage proving HTTP 503.
- Defined `OPENAI_TIMEOUT_MS` as the overall inference deadline in the cutover
  plan.

No live OpenAI or n8n call was made. No deployment, SQL, schema, endpoint,
response-shape, Telegram transport, n8n workflow, dependency, or test-runner
change was made.

## SDK evidence

Inspected installed official `openai` package version `7.1.0`:

- `client.d.ts` documents `timeout` as a single-request timeout that can take
  longer overall because timed-out requests are retried.
- `client.mjs` resolves `ClientOptions.logLevel` before `OPENAI_LOG`.
- `internal/request-options.d.ts` exposes `signal?: AbortSignal`.
- `resources/responses/responses.d.ts` accepts `RequestOptions` as the second
  argument to `responses.create`.
- `client.mjs` reuses request options across retries, while retry backoff sleep
  is not itself signal-aware. Racing the SDK promise against the same signal
  therefore keeps the Core response within the configured overall deadline.

Context7 was also queried as required by `AGENTS.md`; its official OpenAI API
result confirmed the Responses API usage but did not expose the SDK transport
details above, so the installed official typings/source were authoritative for
this fix.

## RED

Tests were added before production changes.

Command:

```text
rtk tsc -p tsconfig.test.json
rtk node --test --test-name-pattern="disables SDK logging|overall request deadline|syntactically invalid JSON" dist-test/src/ai/veyra-ai.service.spec.js
```

Output:

```text
TypeScript: No errors found
✖ dist-test/src/ai/veyra-ai.service.spec.js
ℹ tests 1
ℹ pass 0
ℹ fail 1
```

The direct diagnostic run exposed the two expected behavior failures:

```text
✖ disables SDK logging even when OPENAI_LOG is debug
AssertionError: 'debug' !== 'off'

✖ uses OPENAI_TIMEOUT_MS as the overall request deadline
AssertionError: Missing expected rejection (ServiceUnavailableException).

✔ maps syntactically invalid JSON output to 503
```

The invalid-JSON and model-produced-reset cases were characterization tests for
already-correct behavior; they passed before production changes. The two new
production behaviors above failed for the intended reasons.

## GREEN

Command:

```text
rtk tsc -p tsconfig.test.json
rtk node --test dist-test/src/ai/veyra-ai.service.spec.js
rtk node --test --test-name-pattern="model-produced reset intent" dist-test/src/veyra/transactions/transaction.service.spec.js
```

Output:

```text
TypeScript: No errors found
✔ dist-test/src/ai/veyra-ai.service.spec.js
ℹ pass 1
ℹ fail 0
✔ dist-test/src/veyra/transactions/transaction.service.spec.js
ℹ pass 1
ℹ fail 0
```

## Files changed

- `src/ai/veyra-ai.service.ts`
- `src/ai/veyra-ai.service.spec.ts`
- `src/veyra/transactions/transaction.service.spec.ts`
- `docs/superpowers/plans/2026-07-29-manual-transaction-llm-migration.md`
- `.superpowers/sdd/2026-07-29-manual-transaction-llm-migration/final-fix-report.md`

## Final verification

Command:

```text
rtk tsc -p tsconfig.test.json
rtk node --test dist-test/src/ai/veyra-ai.service.spec.js
rtk node --test dist-test/src/veyra/transactions/transaction.service.spec.js
rtk npm run lint
rtk npm test
rtk npm run build
```

Output:

```text
TypeScript: No errors found
✔ dist-test/src/ai/veyra-ai.service.spec.js
ℹ pass 1
ℹ fail 0
✔ dist-test/src/veyra/transactions/transaction.service.spec.js
ℹ pass 1
ℹ fail 0
> eslint "src/**/*.ts"
> tsc -p tsconfig.test.json && node --test dist-test/src/**/*.spec.js
✔ dist-test/src/aegis/aegis-alert-formatter.service.spec.js
✔ dist-test/src/ai/veyra-ai.service.spec.js
✔ dist-test/src/veyra/veyra.controller.spec.js
ℹ pass 3
ℹ fail 0
> nest build
```

All six commands exited `0`.

## Self-review

- Preserved `gpt-5-mini`, `store: false`, strict structured output,
  `maxRetries: 2`, response-ID/token telemetry, and caller-provided `llmResult`.
- The SDK receives the same overall signal used by the Core deadline race.
- Logging remains metadata-only; SDK logging cannot inherit `OPENAI_LOG`.
- Reset coverage proves no database query and exactly one state reset.
- Invalid JSON still maps to the sanitized 503 response.

## Concerns

The SDK's underlying promise may finish unwinding after Core has returned 503
when the deadline expires during SDK backoff. The shared aborted signal blocks
the next network attempt, and the raced promise retains rejection handling.
No blocker remains.
