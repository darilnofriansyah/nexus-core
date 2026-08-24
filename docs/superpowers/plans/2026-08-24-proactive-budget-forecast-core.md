# Veyra Proactive Budget Forecast Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Return one post-delivery-recorded pocket forecast alert from existing transaction watchdog responses and expose all live pocket forecast risks through the existing dashboard overview.

**Architecture:** Reuse the current transaction watchdog, budget status resolution, `budget_alerts` uniqueness, and dashboard queries. A shared pure calculator keeps watchdog and dashboard math identical; forecast alerts are returned before recording, while current non-forecast threshold behavior stays unchanged. Mini App rendering and n8n workflow changes remain separate owning-workspace work.

**Tech Stack:** NestJS 10, TypeScript 5.7, PostgreSQL via `pg`, Node.js built-in test runner, Telegram Mini App direct links.

**Spec:** `docs/superpowers/specs/2026-08-24-proactive-budget-forecast-integration-design.md`

## Global Constraints

- Read `docs/veyra-database-schema.md` before changing repository logic or SQL.
- Preserve the existing PostgreSQL schema; add no migration or table.
- Preserve n8n ownership of triggers, Telegram delivery, retries, credentials, and orchestration.
- Do not modify or call production n8n workflows during this plan.
- Do not deploy.
- Do not run `npm build` or `npm run build`; builds run only in GitHub Actions.
- Add no dependency or test framework.
- Only confirmed expenses are forecast-eligible.
- Use `transactions.pocket_id` first and the existing null-pocket category fallback second.
- Use a parent pocket amount when positive; otherwise aggregate active child-budget amounts.
- Keep IDR amounts as non-negative safe integers at API boundaries.
- Keep `budget_forecast_overrun` delivery at-least-once; do not add outbox or delivery-state persistence.
- Missing Mini App URL must omit the URL button without failing transaction persistence.
- Treat the Mini App start parameter as navigation, never authorization.
- Keep unrelated dirty worktree files unstaged and unchanged.

## Scope Split

This plan implements only the Core API portion in `nexus-core`. The approved spec also defines two independent external deliverables:

1. Mini App dashboard rendering and `startapp=pocket_<budgetId>` routing in the Mini App repository.
2. n8n notification mapping and post-delivery alert recording in an authorized non-production workflow.

Those deliverables need separate plans in their owning workspaces. Core completion alone does not authorize production integration.

## File Map

### Create

- `src/veyra/budgets/budget-forecast.ts` — pure, clock-free forecast calculation shared by watchdog and dashboard.
- `src/veyra/budgets/budget-forecast.spec.ts` — focused calculation boundaries.

### Modify

- `src/config/env.ts` — expose optional `VEYRA_MINI_APP_BASE_URL`.
- `.env.example` — document the optional Telegram Mini App direct-link base.
- `src/veyra/budgets/dto/overspending-check.dto.ts` — add optional post-delivery forecast fields to watchdog alerts.
- `src/veyra/budgets/budget.service.ts` — use the shared calculation, return unrecorded forecast metadata, preserve other threshold inserts.
- `src/veyra/budgets/budget.service.spec.ts` — assert forecast math, link construction, dedupe, and no pre-delivery forecast insert.
- `src/veyra/transactions/dto/confirmation-payload.dto.ts` — allow exactly one Telegram inline-button action: callback data or URL.
- `src/veyra/transactions/dto/transaction-watchdog.dto.ts` — expose forecast alert metadata and record payload.
- `src/veyra/transactions/transaction.service.ts` — map enriched budget facts into the existing notification list.
- `src/veyra/transactions/transaction.service.spec.ts` — preserve ordering and assert exact forecast notification mapping.
- `src/veyra/transactions/test/fixtures/watchdog/n8n-mapping.json` — fixture the URL keyboard and `alertRecord` contract.
- `src/veyra/dashboard/dto/dashboard-overview.dto.ts` — add `current.attention` without adding it to `previous`.
- `src/veyra/dashboard/dashboard-overview.repository.ts` — include `transactions.pocket_id` in the existing query and mapped model.
- `src/veyra/dashboard/dashboard-overview.repository.spec.ts` — verify explicit pocket mapping.
- `src/veyra/dashboard/dashboard-overview.service.ts` — build live, ordered attention items with the shared calculation.
- `src/veyra/dashboard/dashboard-overview.service.spec.ts` — verify pocket scope, ordering, resolution, and backward-compatible sections.
- `src/veyra/dashboard/dashboard-overview.controller.spec.ts` — update the typed response fixture with `current.attention`.
- `README.md` — document Core response shapes and the n8n send → record mapping.

---

### Task 1: Add the Shared Clock-Free Forecast Calculator

**Files:**
- Create: `src/veyra/budgets/budget-forecast.ts`
- Create: `src/veyra/budgets/budget-forecast.spec.ts`

**Interfaces:**
- Consumes: non-negative safe IDR integers plus `YYYY-MM-DD` cycle/reference dates.
- Produces: `calculateBudgetForecast(input: BudgetForecastInput): BudgetForecastResult | null`.
- Produces types: `BudgetForecastInput`, `BudgetForecastResult`.

- [ ] **Step 1: Write the failing calculation tests**

Create `src/veyra/budgets/budget-forecast.spec.ts`:

```ts
import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { calculateBudgetForecast } from './budget-forecast';

test('projects cycle spend from the inclusive reference day', () => {
  assert.deepEqual(
    calculateBudgetForecast({
      spentAmount: 500_000,
      budgetAmount: 1_500_000,
      cycleStart: '2026-07-01',
      cycleEnd: '2026-08-01',
      asOfDate: '2026-07-10',
    }),
    {
      elapsedDays: 10,
      cycleDays: 31,
      remainingDays: 21,
      projectedSpend: 1_550_000,
      projectedOverrun: 50_000,
      remainingAmount: 1_000_000,
      safeDailySpend: 47_619,
    },
  );
});

test('uses one remaining day on the final cycle day', () => {
  assert.deepEqual(
    calculateBudgetForecast({
      spentAmount: 1_600_000,
      budgetAmount: 1_500_000,
      cycleStart: '2026-07-01',
      cycleEnd: '2026-08-01',
      asOfDate: '2026-07-31',
    }),
    {
      elapsedDays: 31,
      cycleDays: 31,
      remainingDays: 1,
      projectedSpend: 1_600_000,
      projectedOverrun: 100_000,
      remainingAmount: 0,
      safeDailySpend: 0,
    },
  );
});

test('rejects invalid ranges and non-positive budgets', () => {
  assert.equal(
    calculateBudgetForecast({
      spentAmount: 10,
      budgetAmount: 0,
      cycleStart: '2026-07-01',
      cycleEnd: '2026-08-01',
      asOfDate: '2026-07-10',
    }),
    null,
  );
  assert.equal(
    calculateBudgetForecast({
      spentAmount: 10,
      budgetAmount: 100,
      cycleStart: '2026-07-01',
      cycleEnd: '2026-08-01',
      asOfDate: '2026-08-01',
    }),
    null,
  );
});
```

- [ ] **Step 2: Compile to verify the new import fails**

Run:

```bash
npx tsc -p tsconfig.test.json
```

Expected: FAIL with `Cannot find module './budget-forecast'`.

- [ ] **Step 3: Implement the pure calculator**

Create `src/veyra/budgets/budget-forecast.ts`:

```ts
const DAY_MS = 86_400_000;

export interface BudgetForecastInput {
  spentAmount: number;
  budgetAmount: number;
  cycleStart: string;
  cycleEnd: string;
  asOfDate: string;
}

export interface BudgetForecastResult {
  elapsedDays: number;
  cycleDays: number;
  remainingDays: number;
  projectedSpend: number;
  projectedOverrun: number;
  remainingAmount: number;
  safeDailySpend: number;
}

export function calculateBudgetForecast(
  input: BudgetForecastInput,
): BudgetForecastResult | null {
  if (
    !Number.isSafeInteger(input.spentAmount) ||
    input.spentAmount < 0 ||
    !Number.isSafeInteger(input.budgetAmount) ||
    input.budgetAmount <= 0
  ) {
    return null;
  }

  const start = parseDate(input.cycleStart);
  const end = parseDate(input.cycleEnd);
  const reference = parseDate(input.asOfDate);

  if (!start || !end || !reference || reference < start || reference >= end) {
    return null;
  }

  const cycleDays = daysBetween(start, end);
  if (cycleDays < 1) return null;

  const elapsedDays = daysBetween(start, reference) + 1;
  const remainingDays = Math.max(1, cycleDays - elapsedDays);
  const projectedSpend = Math.round(
    (input.spentAmount / elapsedDays) * cycleDays,
  );
  const remainingAmount = Math.max(
    0,
    input.budgetAmount - input.spentAmount,
  );

  return {
    elapsedDays,
    cycleDays,
    remainingDays,
    projectedSpend,
    projectedOverrun: Math.max(0, projectedSpend - input.budgetAmount),
    remainingAmount,
    safeDailySpend: Math.floor(remainingAmount / remainingDays),
  };
}

function parseDate(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10) === value ? date : null;
}

function daysBetween(start: Date, end: Date): number {
  return Math.round((end.getTime() - start.getTime()) / DAY_MS);
}
```

- [ ] **Step 4: Compile and run the focused tests**

Run:

```bash
npx tsc -p tsconfig.test.json
node --test dist-test/src/veyra/budgets/budget-forecast.spec.js
```

Expected: both commands PASS; three tests pass.

- [ ] **Step 5: Commit the calculator**

```bash
git add src/veyra/budgets/budget-forecast.ts src/veyra/budgets/budget-forecast.spec.ts
git commit -m "feat(veyra): share budget forecast calculation"
```

---

### Task 2: Return Forecast Alerts Without Pre-Delivery Recording

**Files:**
- Modify: `src/config/env.ts:1-19`
- Modify: `.env.example:1-14`
- Modify: `src/veyra/budgets/dto/overspending-check.dto.ts:1-101`
- Modify: `src/veyra/budgets/budget.service.ts:700-815,1088-1170,1250-1280`
- Modify: `src/veyra/budgets/budget.service.spec.ts:1880-2280`

**Interfaces:**
- Consumes: `calculateBudgetForecast()` from Task 1.
- Produces: forecast `BudgetWatchdogAlertDto` fields `topDriver`, `telegramText`, `miniAppUrl`, and `alertRecord`.
- Preserves: existing `BudgetService.evaluateTransaction()` signature and non-forecast alert inserts.

- [ ] **Step 1: Add a failing post-delivery forecast test**

Add this focused test to `src/veyra/budgets/budget.service.spec.ts`:

```ts
test('watchdog returns forecast facts without recording before delivery', async () => {
  const previousUrl = process.env.VEYRA_MINI_APP_BASE_URL;
  process.env.VEYRA_MINI_APP_BASE_URL = 'https://t.me/veyra/app';

  try {
    const { calls, service } = createService([
      [
        {
          id: 123,
          user_id: 1,
          transaction_type: 'expense',
          category: 'Dining',
          status: 'confirmed',
          transaction_date: '2026-08-20T12:00:00.000Z',
          pocket_id: '42',
        },
      ],
      [{ cycle_start_day: 1 }],
      [
        {
          budget_id: '42',
          category: 'Food',
          parent_budget_id: null,
          budget_amount: '1500000',
          spent_amount: '1000000',
          child_breakdown: [
            {
              budget_id: '84',
              category: 'Dining',
              budget_amount: '1000000',
              spent_amount: '600000',
            },
          ],
        },
      ],
      [{ exists: false }],
    ]);

    const result = await service.evaluateTransaction({
      userId: 1,
      transactionId: 123,
      timezone: 'Asia/Jakarta',
    });
    const alert = result.alerts[0];

    assert.equal(calls.length, 4);
    assert.equal(calls.some(({ text }) => /INSERT INTO budget_alerts/.test(text)), false);
    assert.deepEqual(alert, {
      type: 'budget_forecast_overrun',
      budgetId: '42',
      category: 'Food',
      usedPercent: 66.67,
      remainingAmount: 500000,
      safeDailySpend: 45454,
      projectedCycleSpend: 1550000,
      projectedOverrun: 50000,
      topDriver: { category: 'Dining', amount: 600000 },
      telegramText: [
        'Food may exceed its budget by Rp50.000 this cycle.',
        'Rp1.000.000 spent of Rp1.500.000.',
        'Safe daily spend: Rp45.454.',
        'Top driver: Dining (Rp600.000).',
      ].join('\n'),
      miniAppUrl: 'https://t.me/veyra/app?startapp=pocket_42',
      alertRecord: {
        userId: '1',
        budgetId: '42',
        alertType: 'budget_forecast_overrun',
        thresholdPercent: 0,
        periodKey: '2026-08-01',
      },
    });
  } finally {
    if (previousUrl === undefined) delete process.env.VEYRA_MINI_APP_BASE_URL;
    else process.env.VEYRA_MINI_APP_BASE_URL = previousUrl;
  }
});
```

- [ ] **Step 2: Add failing dedupe and missing-link tests**

Add two cases beside the first test:

```ts
test('watchdog suppresses an already recorded forecast', async () => {
  const { service } = createService([
    [{
      id: 123,
      user_id: 1,
      transaction_type: 'expense',
      category: 'Food',
      status: 'confirmed',
      transaction_date: '2026-08-20T12:00:00.000Z',
      pocket_id: '42',
    }],
    [{ cycle_start_day: 1 }],
    [{
      budget_id: '42',
      category: 'Food',
      parent_budget_id: null,
      budget_amount: '1500000',
      spent_amount: '1000000',
      child_breakdown: [],
    }],
    [{ exists: true }],
  ]);

  const result = await service.evaluateTransaction({
    userId: 1,
    transactionId: 123,
    timezone: 'Asia/Jakarta',
  });

  assert.deepEqual(result.alerts, []);
  assert.equal(result.hasAlert, false);
});

test('watchdog keeps forecast text when Mini App URL is missing', async () => {
  const previousUrl = process.env.VEYRA_MINI_APP_BASE_URL;
  delete process.env.VEYRA_MINI_APP_BASE_URL;

  try {
    const { service } = createService([
      [{
        id: 123,
        user_id: 1,
        transaction_type: 'expense',
        category: 'Food',
        status: 'confirmed',
        transaction_date: '2026-08-20T12:00:00.000Z',
        pocket_id: '42',
      }],
      [{ cycle_start_day: 1 }],
      [{
        budget_id: '42',
        category: 'Food',
        parent_budget_id: null,
        budget_amount: '1500000',
        spent_amount: '1000000',
        child_breakdown: [],
      }],
      [{ exists: false }],
    ]);

    const result = await service.evaluateTransaction({
      userId: 1,
      transactionId: 123,
      timezone: 'Asia/Jakarta',
    });

    assert.match(result.alerts[0]?.telegramText ?? '', /may exceed/);
    assert.equal(result.alerts[0]?.miniAppUrl, null);
  } finally {
    if (previousUrl !== undefined) process.env.VEYRA_MINI_APP_BASE_URL = previousUrl;
  }
});
```

- [ ] **Step 3: Compile and verify the tests fail on the missing contract**

Run:

```bash
npx tsc -p tsconfig.test.json
```

Expected: FAIL because the alert DTO does not yet contain the new fields.

- [ ] **Step 4: Extend environment and alert DTOs**

Add `veyraMiniAppBaseUrl?: string` to `CoreApiEnv` and map `process.env.VEYRA_MINI_APP_BASE_URL` in `readEnv()`.

Add to `.env.example`:

```dotenv
# Optional Telegram direct-link base used by budget forecast buttons.
# VEYRA_MINI_APP_BASE_URL=https://t.me/your_bot/your_app
```

Extend `src/veyra/budgets/dto/overspending-check.dto.ts`:

```ts
export interface BudgetWatchdogTopDriverDto {
  category: string;
  amount: number;
}

export interface BudgetWatchdogAlertDto {
  type: OverspendingAlertType;
  budgetId: string;
  category: string;
  usedPercent: number;
  remainingAmount: number;
  safeDailySpend: number;
  projectedCycleSpend: number;
  projectedOverrun: number;
  topDriver?: BudgetWatchdogTopDriverDto;
  telegramText?: string;
  miniAppUrl?: string | null;
  alertRecord?: OverspendingAlertRecordDto;
}
```

- [ ] **Step 5: Replace clock-based forecast helpers with Task 1**

Import `calculateBudgetForecast` and `readEnv` in `budget.service.ts`. Change `buildWatchdogAlert` to accept the transaction reference date and existing alert record:

```ts
private buildWatchdogAlert(
  status: BudgetStatusResponseDto,
  type: OverspendingAlertType,
  forecast: BudgetForecastResult | null,
  alertRecord: OverspendingAlertRecordDto,
): BudgetWatchdogAlertDto {
  const base = {
    type,
    budgetId: status.budget_id,
    category: status.category,
    usedPercent: status.spent_percent,
    remainingAmount: status.remaining_amount,
    safeDailySpend: forecast?.safeDailySpend ?? 0,
    projectedCycleSpend: forecast?.projectedSpend ?? 0,
    projectedOverrun: forecast?.projectedOverrun ?? 0,
  };

  if (type !== 'budget_forecast_overrun' || !forecast) return base;

  const topDriver = this.forecastTopDriver(status);
  return {
    ...base,
    topDriver,
    telegramText: this.buildForecastTelegramText(
      status,
      forecast,
      topDriver,
    ),
    miniAppUrl: this.forecastMiniAppUrl(status.budget_id),
    alertRecord,
  };
}
```

Add deterministic helpers:

```ts
private forecastTopDriver(
  status: BudgetStatusResponseDto,
): BudgetWatchdogTopDriverDto {
  const child = [...status.child_breakdown].sort(
    (left, right) =>
      right.spent_amount - left.spent_amount ||
      left.category.localeCompare(right.category),
  )[0];
  return child
    ? { category: child.category, amount: child.spent_amount }
    : { category: status.category, amount: status.spent_amount };
}

private forecastMiniAppUrl(budgetId: string): string | null {
  const configured = readEnv().veyraMiniAppBaseUrl?.trim();
  if (!configured) return null;

  try {
    const url = new URL(configured);
    if (url.protocol !== 'https:') return null;
    url.searchParams.set('startapp', `pocket_${budgetId}`);
    return url.toString();
  } catch {
    return null;
  }
}

private buildForecastTelegramText(
  status: BudgetStatusResponseDto,
  forecast: BudgetForecastResult,
  topDriver: BudgetWatchdogTopDriverDto,
): string {
  return [
    `${this.escapeTelegramHtml(status.category)} may exceed its budget by ${this.formatTelegramCurrency(forecast.projectedOverrun)} this cycle.`,
    `${this.formatTelegramCurrency(status.spent_amount)} spent of ${this.formatTelegramCurrency(status.budget_amount)}.`,
    `Safe daily spend: ${this.formatTelegramCurrency(forecast.safeDailySpend)}.`,
    `Top driver: ${this.escapeTelegramHtml(topDriver.category)} (${this.formatTelegramCurrency(topDriver.amount)}).`,
  ].join('\n');
}
```

- [ ] **Step 6: Keep only forecast alerts unrecorded during evaluation**

Calculate the shared forecast once per status before resolving alert types:

```ts
const forecast = calculateBudgetForecast({
  spentAmount: status.spent_amount,
  budgetAmount: status.budget_amount,
  cycleStart: status.cycle_start,
  cycleEnd: status.cycle_end,
  asOfDate: referenceDateString,
});

for (const alertType of this.resolveBudgetWatchdogAlertTypes(status, forecast)) {
  // existing record construction and dedupe check
}
```

Change `resolveBudgetWatchdogAlertTypes()` to accept `BudgetForecastResult | null`. Preserve the 75/90/100 checks and replace its clock-based forecast condition with:

```ts
if ((forecast?.projectedOverrun ?? 0) > 0) {
  alerts.push('budget_forecast_overrun');
}
```

Then preserve the uniqueness check for every alert type and branch after that check:

```ts
const alert = this.buildWatchdogAlert(
  status,
  alertType,
  forecast,
  alertRecord,
);

if (alertType === 'budget_forecast_overrun') {
  alerts.push(alert);
  continue;
}

const inserted = await this.insertBudgetAlert(alertRecord);
if (inserted) alerts.push(alert);
```

Delete the old private `safeDailySpend()`, `projectedCycleSpend()`, and watchdog-only `daysBetween()` methods after all callers use `calculateBudgetForecast()`.

Add and use this helper so the same local day drives cycle lookup and forecasting:

```ts
private transactionLocalDate(
  value: string | Date | null,
  timezone: string | null | undefined,
): string {
  const date = value instanceof Date ? value : new Date(value ?? '');
  if (Number.isNaN(date.getTime())) {
    throw new BadRequestException('transaction date must be valid');
  }

  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: this.cleanString(timezone ?? undefined) ?? 'Asia/Jakarta',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(date);
  } catch {
    throw new BadRequestException('timezone must be valid');
  }
}
```

Set `referenceDateString = this.transactionLocalDate(transaction.transaction_date, request.timezone)`. Pass that string as `asOfDate` to `getBudgetStatus()` and parse the same string for `getDirectBudgetStatus()`.

Do not remove `budget_forecast_overrun` from `resolveBudgetWatchdogAlertTypes()`; the branch above changes only its persistence timing.

- [ ] **Step 7: Update existing watchdog expectations**

In `overspending handle fetches transaction and records Telegram-ready watchdog alert`:

- rename it to state that threshold alerts are recorded while forecast is returned;
- expect six database calls instead of seven;
- expect one `INSERT INTO budget_alerts`, for `budget_75` only;
- assert the returned alerts still include `budget_75` and `budget_forecast_overrun`;
- keep the existing first-alert response assertions unchanged.

Use these concrete assertions:

```ts
assert.equal(calls.length, 6);
assert.equal(
  calls.filter(({ text }) => /INSERT INTO budget_alerts/.test(text)).length,
  1,
);
assert.deepEqual(
  result.alerts.map(({ type }) => type),
  ['budget_75', 'budget_forecast_overrun'],
);
assert.equal(
  result.alerts[1]?.alertRecord?.alertType,
  'budget_forecast_overrun',
);
```

Keep the existing multiple-threshold, explicit-pocket, child-budget, pending, income, and concurrent threshold-insert tests passing.

- [ ] **Step 8: Run the focused budget tests**

Run:

```bash
npx tsc -p tsconfig.test.json
node --test --test-name-pattern="forecast|watchdog|overspending" dist-test/src/veyra/budgets/budget.service.spec.js
node --test dist-test/src/veyra/budgets/budget-forecast.spec.js
```

Expected: all selected tests PASS.

- [ ] **Step 9: Commit the budget alert contract**

```bash
git add .env.example src/config/env.ts src/veyra/budgets/dto/overspending-check.dto.ts src/veyra/budgets/budget.service.ts src/veyra/budgets/budget.service.spec.ts
git commit -m "feat(veyra): return deliverable forecast alerts"
```

---

### Task 3: Enrich Existing Transaction Watchdog Notifications

**Files:**
- Modify: `src/veyra/transactions/dto/confirmation-payload.dto.ts:35-47`
- Modify: `src/veyra/transactions/dto/transaction-watchdog.dto.ts:1-25`
- Modify: `src/veyra/transactions/transaction.service.ts:5430-5480`
- Modify: `src/veyra/transactions/transaction.service.spec.ts:7960-8125`
- Modify: `src/veyra/transactions/test/fixtures/watchdog/n8n-mapping.json:8-35`

**Interfaces:**
- Consumes: enriched `BudgetWatchdogAlertDto` from Task 2.
- Produces: existing `TransactionWatchdogNotificationDto` plus optional `alertType`, `budgetId`, and `alertRecord`.
- Preserves: notification order `risk_review`, `budget_alert`, `burn_rate`.

- [ ] **Step 1: Expand the n8n fixture with the forecast payload**

Replace the fixture's budget message with:

```json
"Shopping may exceed its budget by Rp200.000 this cycle.\nRp900.000 spent of Rp1.000.000.\nSafe daily spend: Rp10.000.\nTop driver: Shopping (Rp900.000)."
```

Add under `notifications`:

```json
"budgetReplyMarkup": {
  "inline_keyboard": [[
    {
      "text": "View Shopping pocket",
      "url": "https://t.me/veyra/app?startapp=pocket_12"
    }
  ]]
},
"budgetAlertRecord": {
  "userId": "1",
  "budgetId": "12",
  "alertType": "budget_forecast_overrun",
  "thresholdPercent": 0,
  "periodKey": "2026-08-01"
}
```

Extend the `watchdogN8nFixture` TypeScript assertion in `transaction.service.spec.ts` with matching fields:

```ts
budgetReplyMarkup: {
  inline_keyboard: Array<Array<{ text: string; url: string }>>;
};
budgetAlertRecord: {
  userId: string;
  budgetId: string;
  alertType: 'budget_forecast_overrun';
  thresholdPercent: number;
  periodKey: string;
};
```

- [ ] **Step 2: Change the existing ordering test to require the new mapping**

Make its fake budget alert use `type: 'budget_forecast_overrun'` and include:

```ts
telegramText: watchdogN8nFixture.notifications.messages[1],
miniAppUrl: 'https://t.me/veyra/app?startapp=pocket_12',
alertRecord: watchdogN8nFixture.notifications.budgetAlertRecord,
topDriver: { category: 'Shopping', amount: 900000 },
```

Add assertions:

```ts
assert.deepEqual(
  result.notifications[1].reply_markup,
  watchdogN8nFixture.notifications.budgetReplyMarkup,
);
assert.deepEqual(
  result.notifications[1].alertRecord,
  watchdogN8nFixture.notifications.budgetAlertRecord,
);
assert.equal(result.notifications[1].alertType, 'budget_forecast_overrun');
assert.equal(result.notifications[1].budgetId, '12');
```

- [ ] **Step 3: Compile and verify the DTO assertions fail**

Run:

```bash
npx tsc -p tsconfig.test.json
```

Expected: FAIL because the Telegram button and notification DTOs do not expose the new URL/record fields.

- [ ] **Step 4: Allow callback or URL Telegram buttons**

Replace `TelegramInlineKeyboardButtonDto` with an exclusive union:

```ts
export type TelegramInlineKeyboardButtonDto =
  | { text: string; callback_data: string; url?: never }
  | { text: string; url: string; callback_data?: never };
```

Keep `TelegramReplyMarkupDto.inline_keyboard` unchanged.

- [ ] **Step 5: Extend the watchdog notification DTO**

Add imports and optional fields:

```ts
import {
  OverspendingAlertRecordDto,
  OverspendingAlertType,
} from '../../budgets/dto/overspending-check.dto';

export interface TransactionWatchdogNotificationDto {
  type: TransactionWatchdogNotificationType;
  priority: number;
  severity: 'warning' | 'high';
  message: string;
  review_id?: number;
  reply_markup?: TelegramReplyMarkupDto;
  alertType?: OverspendingAlertType;
  budgetId?: string;
  alertRecord?: OverspendingAlertRecordDto;
}
```

- [ ] **Step 6: Map forecast facts without changing other budget alerts**

Replace `toBudgetNotifications()` with:

```ts
private toBudgetNotifications(
  watchdog: BudgetWatchdogResponseDto | undefined,
): TransactionWatchdogNotificationDto[] {
  return (watchdog?.alerts ?? []).map((alert) => {
    const base: TransactionWatchdogNotificationDto = {
      type: 'budget_alert',
      priority: 2,
      severity: 'warning',
      message: `${alert.category} budget reached ${alert.usedPercent}%`,
    };

    if (alert.type !== 'budget_forecast_overrun') return base;

    return {
      ...base,
      message: alert.telegramText ?? base.message,
      alertType: alert.type,
      budgetId: alert.budgetId,
      ...(alert.alertRecord ? { alertRecord: alert.alertRecord } : {}),
      ...(alert.miniAppUrl
        ? {
            reply_markup: {
              inline_keyboard: [
                [
                  {
                    text: `View ${alert.category} pocket`,
                    url: alert.miniAppUrl,
                  },
                ],
              ],
            },
          }
        : {}),
    };
  });
}
```

Do not change risk-review or burn-rate mapping.

- [ ] **Step 7: Add a no-link regression assertion**

Add this focused test:

```ts
test('forecast notification keeps facts without an unconfigured Mini App link', async () => {
  const alertRecord = {
    userId: '1',
    budgetId: '12',
    alertType: 'budget_forecast_overrun' as const,
    thresholdPercent: 0,
    periodKey: '2026-08-01',
  };
  const budgetService = {
    evaluateTransaction: async () => ({
      checked: true,
      hasAlert: true,
      alerts: [{
        type: 'budget_forecast_overrun' as const,
        budgetId: '12',
        category: 'Shopping',
        usedPercent: 90,
        remainingAmount: 100000,
        safeDailySpend: 10000,
        projectedCycleSpend: 1200000,
        projectedOverrun: 200000,
        telegramText: 'Shopping may exceed its budget.',
        miniAppUrl: null,
        alertRecord,
      }],
      message: null,
    }),
  } as unknown as BudgetService;
  const { service } = createService(
    [[{
      ...transaction,
      id: '101',
      user_id: '1',
      transaction_type: 'expense',
      status: 'confirmed',
    }]],
    budgetService,
  );

  const result = await service.evaluateTransactionWatchdog('101');
  const notification = result.notifications.find(
    ({ type }) => type === 'budget_alert',
  );

  assert.equal(notification?.message, 'Shopping may exceed its budget.');
  assert.equal(notification?.budgetId, '12');
  assert.deepEqual(notification?.alertRecord, alertRecord);
  assert.equal(notification?.reply_markup, undefined);
});
```

- [ ] **Step 8: Run focused transaction watchdog tests**

Run:

```bash
npx tsc -p tsconfig.test.json
node --test --test-name-pattern="watchdog" dist-test/src/veyra/transactions/transaction.service.spec.js
```

Expected: all watchdog tests PASS and notification order remains unchanged.

- [ ] **Step 9: Commit transaction notification mapping**

```bash
git add src/veyra/transactions/dto/confirmation-payload.dto.ts src/veyra/transactions/dto/transaction-watchdog.dto.ts src/veyra/transactions/transaction.service.ts src/veyra/transactions/transaction.service.spec.ts src/veyra/transactions/test/fixtures/watchdog/n8n-mapping.json
git commit -m "feat(veyra): enrich forecast watchdog notifications"
```

---

### Task 4: Add Live Forecast Attention to Dashboard Overview

**Files:**
- Modify: `src/veyra/dashboard/dto/dashboard-overview.dto.ts:1-77`
- Modify: `src/veyra/dashboard/dashboard-overview.repository.ts:1-145`
- Modify: `src/veyra/dashboard/dashboard-overview.repository.spec.ts:35-125`
- Modify: `src/veyra/dashboard/dashboard-overview.service.ts:1-285`
- Modify: `src/veyra/dashboard/dashboard-overview.service.spec.ts:1-430`
- Modify: `src/veyra/dashboard/dashboard-overview.controller.spec.ts:1-75`

**Interfaces:**
- Consumes: `calculateBudgetForecast()` from Task 1.
- Produces: `DashboardAttentionDto` and `DashboardCurrentPeriodOverviewDto`.
- Preserves: `previous` response shape and every existing dashboard field.

- [ ] **Step 1: Write the failing repository pocket-mapping test**

Update the transaction row in `findTransactions reads only confirmed income and expenses in local dates` with `pocket_id: '42'`. Require the SQL and mapped result:

```ts
assert.match(calls[0].text, /pocket_id/);
assert.equal(transactions[0]?.pocketId, '42');
```

Add this second database row to the same fake result:

```ts
{
  id: '124',
  transaction_type: 'expense',
  amount: '10000.00',
  merchant: 'Legacy Merchant',
  category: 'Food',
  pocket_id: null,
  transaction_day: '2026-07-23',
  transaction_date: '2026-07-23T03:00:00.000Z',
}
```

Then assert:

```ts
assert.equal(transactions[1]?.pocketId, null);
```

- [ ] **Step 2: Add failing dashboard attention tests**

Extend the service-spec `transaction()` helper with a final optional parameter:

```ts
pocketId: string | null = null,
```

and include `pocketId` in its return value.

Add:

```ts
test('returns live pocket forecast attention ordered by overrun', async () => {
  const { repository, service } = createService();
  repository.budgets = [
    { id: '42', parentId: null, category: 'Food', amount: 1_500_000 },
    { id: '43', parentId: null, category: 'Transport', amount: 500_000 },
  ];
  repository.transactions = [
    transaction('1', '2026-08-20', 1_000_000, 'expense', 'Dining', 'TUKU', '42'),
    transaction('2', '2026-08-20', 400_000, 'expense', 'Ride', 'Gojek', '43'),
  ];

  const result = await service.getOverview({
    userId: 1,
    asOfDate: '2026-08-20',
    timezone: 'Asia/Jakarta',
  });

  assert.deepEqual(
    result.current.attention.map(({ pocketId, projectedOverrun }) => ({
      pocketId,
      projectedOverrun,
    })),
    [
      { pocketId: '43', projectedOverrun: 120000 },
      { pocketId: '42', projectedOverrun: 50000 },
    ],
  );
  assert.deepEqual(result.current.attention[1].topDriver, {
    category: 'Dining',
    amount: 1000000,
  });
});

test('omits attention after a pocket projection resolves', async () => {
  const { repository, service } = createService();
  repository.budgets = [
    { id: '42', parentId: null, category: 'Food', amount: 1_500_000 },
  ];
  repository.transactions = [
    transaction('1', '2026-08-20', 500_000, 'expense', 'Dining', 'TUKU', '42'),
  ];

  const result = await service.getOverview({
    userId: 1,
    asOfDate: '2026-08-20',
  });

  assert.deepEqual(result.current.attention, []);
});

test('invalid forecast inputs preserve the rest of the dashboard', async () => {
  const { repository, service } = createService();
  repository.budgets = [
    { id: '42', parentId: null, category: 'Food', amount: Number.NaN },
  ];
  repository.transactions = [
    transaction('1', '2026-08-20', 25000, 'expense', 'Dining', 'TUKU', '42'),
  ];

  const result = await service.getOverview({
    userId: 1,
    asOfDate: '2026-08-20',
  });

  assert.equal(result.current.totals.spent, 25000);
  assert.deepEqual(result.current.attention, []);
});
```

- [ ] **Step 3: Add a failing explicit-pocket versus legacy-fallback test**

Add:

```ts
test('explicit pocket assignment wins before legacy category fallback', async () => {
  const { repository, service } = createService();
  repository.budgets = [
    { id: '42', parentId: null, category: 'Food Pocket', amount: 1_000_000 },
    { id: '84', parentId: '42', category: 'Dining', amount: 500_000 },
    { id: '43', parentId: null, category: 'Travel Pocket', amount: 1_000_000 },
    { id: '85', parentId: '43', category: 'dining', amount: 500_000 },
  ];
  repository.transactions = [
    transaction('1', '2026-08-20', 100, 'expense', 'Dining', 'TUKU', '42'),
    transaction('2', '2026-08-20', 50, 'expense', 'Dining', 'Legacy', null),
  ];

  const result = await service.getOverview({
    userId: 1,
    asOfDate: '2026-08-20',
  });

  assert.deepEqual(
    result.current.budgets.map(({ category, spent }) => ({ category, spent })),
    [
      { category: 'Food Pocket', spent: 150 },
      { category: 'Travel Pocket', spent: 50 },
    ],
  );
});
```

- [ ] **Step 4: Compile and verify the new fields fail**

Run:

```bash
npx tsc -p tsconfig.test.json
```

Expected: FAIL because `DashboardTransaction.pocketId` and `current.attention` do not exist.

- [ ] **Step 5: Extend repository transaction mapping**

Add `pocketId: string | null` to `DashboardTransaction`, `pocket_id` to `TransactionRow`, select `pocket_id` in `findTransactions()`, and map it with:

```ts
pocketId: row.pocket_id === null ? null : String(row.pocket_id),
```

Do not add a query; extend the existing transaction query only.

- [ ] **Step 6: Add dashboard attention DTOs without changing `previous`**

Add:

```ts
export interface DashboardAttentionDto {
  type: 'budget_forecast_overrun';
  pocketId: string;
  pocketName: string;
  limit: number;
  spent: number;
  projectedSpend: number;
  projectedOverrun: number;
  safeDailySpend: number;
  topDriver: {
    category: string;
    amount: number;
  };
}

export interface DashboardCurrentPeriodOverviewDto
  extends DashboardPeriodOverviewDto {
  attention: DashboardAttentionDto[];
}
```

Change only `DashboardOverviewResponseDto.current` to `DashboardCurrentPeriodOverviewDto`; leave `previous` as `DashboardPeriodOverviewDto`.

- [ ] **Step 7: Build pocket snapshots once and reuse them**

In `dashboard-overview.service.ts`, add a private snapshot type:

```ts
interface DashboardPocketSnapshot {
  id: string;
  name: string;
  limit: number;
  spent: number;
  expenses: DashboardTransaction[];
}
```

For each active top-level budget:

```ts
const children = budgets.filter(({ parentId }) => parentId === budget.id);
const legacyCategories = new Set(
  (children.length ? children : [budget]).map(({ category }) =>
    category.trim().toLocaleLowerCase(),
  ),
);
const scopedExpenses = expenses.filter(
  (transaction) =>
    transaction.pocketId === budget.id ||
    (transaction.pocketId === null &&
      transaction.category !== null &&
      legacyCategories.has(transaction.category.trim().toLocaleLowerCase())),
);
const limit =
  budget.amount > 0
    ? budget.amount
    : children.reduce((sum, child) => sum + child.amount, 0);
```

Use these snapshots for both the existing `current.budgets` output and new attention output. This prevents formula and pocket-scope duplication.

In the existing parent-budget service test, change the parent fixture amount from `9999999` to `0` so the test continues to exercise child aggregation. Add this focused parent-limit case:

```ts
test('uses a positive parent amount before child budget totals', async () => {
  const { repository, service } = createService();
  repository.budgets = [
    { id: '42', parentId: null, category: 'Food', amount: 2_000_000 },
    { id: '84', parentId: '42', category: 'Dining', amount: 500_000 },
    { id: '85', parentId: '42', category: 'Groceries', amount: 700_000 },
  ];

  const result = await service.getOverview({
    userId: 1,
    asOfDate: '2026-08-20',
  });

  assert.equal(result.current.budgets[0]?.limit, 2_000_000);
});
```

- [ ] **Step 8: Calculate and order live attention**

Add `Logger` and import `calculateBudgetForecast`. Build attention with the validated `asOfDate` already produced by `getOverview()`:

```ts
private attention(
  snapshots: DashboardPocketSnapshot[],
  period: DashboardPeriodDto,
  asOfDate: string,
): DashboardAttentionDto[] {
  try {
    return snapshots
      .map((snapshot) => {
        const forecast = calculateBudgetForecast({
          spentAmount: snapshot.spent,
          budgetAmount: snapshot.limit,
          cycleStart: period.start,
          cycleEnd: period.end,
          asOfDate,
        });
        if (!forecast || forecast.projectedOverrun === 0) return null;

        return {
          type: 'budget_forecast_overrun' as const,
          pocketId: snapshot.id,
          pocketName: snapshot.name,
          limit: snapshot.limit,
          spent: snapshot.spent,
          projectedSpend: forecast.projectedSpend,
          projectedOverrun: forecast.projectedOverrun,
          safeDailySpend: forecast.safeDailySpend,
          topDriver: this.topDriver(snapshot),
        };
      })
      .filter((item): item is DashboardAttentionDto => item !== null)
      .sort(
        (left, right) =>
          right.projectedOverrun - left.projectedOverrun ||
          left.pocketName.localeCompare(right.pocketName),
      );
  } catch (error) {
    this.logger.warn(
      'Dashboard forecast attention calculation failed',
      error instanceof Error ? error.message : undefined,
    );
    return [];
  }
}
```

Add:

```ts
private topDriver(snapshot: DashboardPocketSnapshot): {
  category: string;
  amount: number;
} {
  const totals = new Map<string, { category: string; amount: number }>();

  for (const transaction of snapshot.expenses) {
    const category = transaction.category?.trim() || 'Uncategorized';
    const key = category.toLocaleLowerCase();
    const current = totals.get(key) ?? { category, amount: 0 };
    current.amount += transaction.amount;
    totals.set(key, current);
  }

  return (
    [...totals.values()].sort(
      (left, right) =>
        right.amount - left.amount ||
        left.category.localeCompare(right.category),
    )[0] ?? { category: snapshot.name, amount: snapshot.spent }
  );
}
```

- [ ] **Step 9: Add attention only to current overview**

Change `overview()` to consume `DashboardPocketSnapshot[]` instead of raw `DashboardBudget[]` and set its budget field with:

```ts
budgets: snapshots
  .map(({ name, limit, spent }) => {
    const percent = limit === 0 ? 0 : Math.round((spent / limit) * 10000) / 100;
    return {
      category: name,
      limit,
      spent,
      percent,
      status: this.budgetStatus(percent),
    };
  })
  .sort(
    (left, right) =>
      right.spent - left.spent || right.percent - left.percent,
  )
  .slice(0, 4),
```

In `currentOverview()`, calculate `currentTransactions` and `snapshots` once, pass the snapshots into `overview()`, and return:

```ts
return {
  ...overview,
  attention: this.attention(snapshots, cycles.current, asOfDate),
};
```

In `previousOverview()`, calculate previous-cycle transactions and its snapshots once, then pass those snapshots into `overview()`. Pass `asOfDate` from `getOverview()` into `currentOverview()`. Do not add `attention` inside the shared `overview()` method, because that method also builds `previous`.

Update the controller typed fixture and all exact `Object.keys(result.current)` assertions to include `attention`. Keep `Object.keys(result.previous)` unchanged.

- [ ] **Step 10: Run focused dashboard tests**

Run:

```bash
npx tsc -p tsconfig.test.json
node --test dist-test/src/veyra/dashboard/dashboard-overview.repository.spec.js
node --test dist-test/src/veyra/dashboard/dashboard-overview.service.spec.js
node --test dist-test/src/veyra/dashboard/dashboard-overview.controller.spec.js
```

Expected: all dashboard tests PASS.

- [ ] **Step 11: Commit dashboard attention**

```bash
git add src/veyra/dashboard/dto/dashboard-overview.dto.ts src/veyra/dashboard/dashboard-overview.repository.ts src/veyra/dashboard/dashboard-overview.repository.spec.ts src/veyra/dashboard/dashboard-overview.service.ts src/veyra/dashboard/dashboard-overview.service.spec.ts src/veyra/dashboard/dashboard-overview.controller.spec.ts
git commit -m "feat(veyra): expose dashboard forecast attention"
```

---

### Task 5: Document the Core and n8n Contracts and Run Full Verification

**Files:**
- Modify: `README.md:256-405,1007-1135,1200-1310`

**Interfaces:**
- Consumes: final DTO shapes from Tasks 2-4.
- Produces: exact Mini App handoff and n8n send → record documentation.

- [ ] **Step 1: Update the dashboard overview example**

Add `current.attention` with the exact JSON keys from `DashboardAttentionDto`. State explicitly:

- Core returns all live items ordered by overrun;
- the Mini App displays three and exposes `View all at-risk pockets`;
- opening a pocket does not dismiss the warning;
- `previous` has no `attention` property;
- `budget_alerts` delivery history does not control dashboard visibility.

- [ ] **Step 2: Update transaction watchdog documentation**

Add the exact forecast notification JSON from the spec, including `reply_markup` and `alertRecord`. Document that current non-forecast threshold alerts retain their existing persistence behavior while `budget_forecast_overrun` uses post-delivery recording.

- [ ] **Step 3: Document the n8n send → record payload**

Add these exact node responsibilities:

```text
Existing transaction HTTP Request
→ split/iterate notifications
→ Telegram Reliable Sender using message + reply_markup
→ IF alertRecord exists
→ POST /api/veyra/budgets/overspending/record with alertRecord
```

State that Telegram send failure skips recording, while record failure retries only the record request. Include the approved at-least-once duplicate limitation.

- [ ] **Step 4: Document the Mini App handoff**

Document:

```text
VEYRA_MINI_APP_BASE_URL=https://t.me/<bot>/<app>
startapp=pocket_<budgetId>
```

State that the Mini App server validates Telegram `initData`, resolves the Telegram identity, and relies on Core pocket ownership checks. State that the start parameter contains no user ID or financial data.

- [ ] **Step 5: Run formatting only on touched TypeScript files**

Run Prettier with the explicit Task 1-4 TypeScript paths. Do not run the repository-wide write command against unrelated files:

```bash
npx prettier --write src/config/env.ts src/veyra/budgets/budget-forecast.ts src/veyra/budgets/budget-forecast.spec.ts src/veyra/budgets/dto/overspending-check.dto.ts src/veyra/budgets/budget.service.ts src/veyra/budgets/budget.service.spec.ts src/veyra/transactions/dto/confirmation-payload.dto.ts src/veyra/transactions/dto/transaction-watchdog.dto.ts src/veyra/transactions/transaction.service.ts src/veyra/transactions/transaction.service.spec.ts src/veyra/dashboard/dto/dashboard-overview.dto.ts src/veyra/dashboard/dashboard-overview.repository.ts src/veyra/dashboard/dashboard-overview.repository.spec.ts src/veyra/dashboard/dashboard-overview.service.ts src/veyra/dashboard/dashboard-overview.service.spec.ts src/veyra/dashboard/dashboard-overview.controller.spec.ts
```

Expected: only listed files may change.

- [ ] **Step 6: Run full local verification**

Run:

```bash
npx tsc -p tsconfig.test.json
node --test "dist-test/src/**/*.spec.js"
npm run lint
git diff --check
```

Expected:

- TypeScript compilation succeeds.
- All tests pass.
- ESLint succeeds.
- `git diff --check` reports no whitespace errors.
- No npm build command is run.

- [ ] **Step 7: Confirm scope before the documentation commit**

Run:

```bash
git status --short
git diff --stat
```

Expected: only files listed in this plan plus pre-existing unrelated dirty files appear. Do not stage `AGENTS.md`, `PROJECT_REVIEW.md`, `.serena/`, `.superpowers/`, secrets, or any unrelated change.

- [ ] **Step 8: Commit documentation and final fixture adjustments**

```bash
git add README.md
git commit -m "docs(veyra): document forecast alert integration"
```

- [ ] **Step 9: Report external handoff boundaries**

Report all of the following without modifying external systems:

- Core commits produced by Tasks 1-5.
- Exact Core notification and dashboard response contracts.
- Mini App files/workspace still required.
- n8n nodes that can replace forecast message construction.
- n8n trigger, sender, retry, and record nodes that remain.
- No production workflow, database schema, or deployment changed.

## Completion Gate

Core work is complete only when:

- all five task commits exist;
- targeted and full tests pass;
- lint and whitespace checks pass;
- `budget_forecast_overrun` is not inserted before Telegram delivery;
- existing non-forecast watchdog behavior remains covered;
- dashboard `current.attention` is live and `previous` remains backward compatible;
- README contains the exact n8n HTTP Request payload;
- no production n8n workflow, database schema, or deployment changed.
