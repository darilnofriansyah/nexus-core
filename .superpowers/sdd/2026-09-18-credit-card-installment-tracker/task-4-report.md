# Task 4 report — post due installment interest exactly once

## Delivered

- Added `POST /api/veyra/installments/post-due-interest` (global Core API-key guard remains in force). It accepts no effective-date or user input and returns `{ postedCount, hasMore }`.
- `InstallmentsService.postDueInterest()` obtains the clock through a protected `currentTime()` seam, then delegates one bounded batch to the repository.
- The repository locks at most 100 eligible schedule rows, ordered by `(due_date, id)`, using `FOR UPDATE OF installment SKIP LOCKED`. It joins the plan and original transaction for owner/snapshot data, does not filter inactive users, and uses the plan timezone to compare a due date.
- Each schedule's ordinary confirmed manual expense and `interest_transaction_id` link are one CTE statement inside the batch transaction. A failure rolls the whole batch back. The charge uses the original owner and plan merchant/category/pocket snapshots; its date is schedule-date midnight in the stored plan timezone.
- `hasMore` is calculated after the selected rows are linked. It may conservatively be true while another worker owns an eligible lock, as designed.

## RED

Added service, repository, controller, and PostgreSQL integration tests before production implementation. `rtk npm test` then failed at TypeScript compilation because `postDueInterest` was absent from all three production classes. The failure listed the new controller, repository, service, and integration-test call sites, establishing the missing behavior rather than a test assertion mismatch.

## GREEN and checks

- `rtk proxy ./node_modules/.bin/tsc -p tsconfig.test.json && rtk proxy node --test --test-concurrency=1 "dist-test/src/veyra/transactions/installments*.spec.js"` — pass: 5 files, 5 pass, 0 fail. The PostgreSQL tests skip when the dedicated URL is unavailable.
- `rtk proxy npx eslint` on all changed installment sources/specs — pass.
- `rtk proxy git diff --check` — pass.
- Attempted `rtk proxy npm test` for the whole project. It reached unrelated pre-existing failures in `codex-worker` and Rovelle suites before the tool's 30-second execution window ended. No installment failure appeared; focused installment suite is green.
- No local build run, per repository instruction.

## Disposable PostgreSQL coverage

The fixture is guarded exclusively by `INSTALLMENTS_TEST_DATABASE_URL`; it explicitly skips unless the URL names the dedicated `installments_test` database and never reads or falls back to `DATABASE_URL`.

New real-PostgreSQL cases cover:

- Rp6,000,000 / 6 months / 1%: first due post creates only Rp60,000; retry creates none; next month adds one Rp60,000 charge; future rows stay unposted.
- Zero-interest schedules create no transaction.
- Existing obligations continue posting after the user becomes inactive.
- A 120-row downtime backlog posts 100 then 20 and reports `hasMore` accurately.
- Two simultaneous callers create six linked charges total, with no duplicates.
- A trigger that rejects the schedule link rolls back the preceding interest insert, leaving the schedule unposted.
- Pacific/Kiritimati midnight boundary posts at the stored local schedule date.

`INSTALLMENTS_TEST_DATABASE_URL` was unset in this environment, so these disposable-DB cases compiled and skipped; they were not executed against PostgreSQL here.

## Accounting coverage

The timezone test runs the existing `BudgetRepository.findPocketStatus` and `DashboardOverviewRepository.findTransactions` against the disposable fixture. It asserts a Rp6,000,000 purchase plus one Rp60,000 posted interest charge sums to Rp6,060,000 in both existing aggregation paths. It also verifies the only generated transaction amount is Rp60,000; installment principal is never inserted again or added to credit-card cycle usage.

## Concurrency and remaining concerns

- `SKIP LOCKED` prevents concurrent workers from selecting the same schedule row, while the schedule lock remains held until the CTE insert/link completes and the outer transaction commits.
- The CTE plus outer transaction prevents an orphaned interest transaction if linking fails. The targeted trigger test exercises that path when the disposable database is configured.
- `hasMore` intentionally has a benign concurrent false-positive window specified by the task.
- Production migration application, deployment, and n8n schedule configuration were not performed. Automatic posting requires the separately authorized scheduler call after deployment.
