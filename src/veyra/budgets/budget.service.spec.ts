import * as assert from "node:assert/strict";
import { mock, test } from "node:test";
import { BadRequestException, NotFoundException } from "@nestjs/common";
import { DatabaseService } from "../../database/database.service";
import { VeyraAiService } from "../../ai/veyra-ai.service";
import { CategoryService } from "../categories/category.service";
import { BudgetRepository } from "./budget.repository";
import { BudgetService } from "./budget.service";

interface ServiceOptions {
  rowsByCall?: unknown[][];
  categoryService?: Partial<CategoryService>;
  repository?: Partial<BudgetRepository>;
  veyraAiService?: Partial<VeyraAiService>;
}

function createService(input: unknown[][] | ServiceOptions = []) {
  const {
    rowsByCall = [],
    categoryService,
    repository,
    veyraAiService,
  } = Array.isArray(input) ? { rowsByCall: input } : input;
  const calls: Array<{ text: string; values: unknown[] }> = [];
  const database = {
    query: async (text: string, values: unknown[] = []) => {
      calls.push({ text, values });
      return { rows: rowsByCall.shift() ?? [] };
    },
  } as unknown as DatabaseService;
  const categories = {
    ensureDefaults: async () => {},
    resolveForSave: async () => ({
      category: "Uncategorized",
      needsReview: true,
    }),
    listActive: async () => [],
    create: async () => ({ id: "1", name: "Category" }),
    archive: async () => false,
    ...categoryService,
  } as unknown as CategoryService;
  const budgets = {
    ensureDefaultPocket: async () => {},
    findPocket: async () => null,
    findDefaultPocket: async () => null,
    resolveLegacyPocketId: async () => "12",
    listPockets: async () => [],
    renamePocket: async () => null,
    setDefaultPocket: async () => null,
    findPocketStatus: async (request: {
      userId: string;
      pocketId?: string;
      category?: string;
      cycleStart: string;
      cycleEnd: string;
    }) => {
      const result = await database.query("findPocketStatus", [
        request.userId,
        request.pocketId ?? null,
        request.cycleStart,
        request.cycleEnd,
        request.category ?? null,
      ]);
      return result.rows[0] ?? null;
    },
    listPocketOverview: async (request: {
      userId: string;
      cycleStart: string;
      cycleEnd: string;
    }) => {
      const result = await database.query("listPocketOverview", [
        request.userId,
        request.cycleStart,
        request.cycleEnd,
      ]);
      return result.rows;
    },
    ...repository,
  } as unknown as BudgetRepository;

  return {
    calls,
    service: new BudgetService(
      database,
      categories,
      budgets,
      veyraAiService as VeyraAiService | undefined,
    ),
  };
}

test("setup ensures categories before default pocket", async () => {
  const events: string[] = [];
  const { service } = createService({
    categoryService: {
      ensureDefaults: async () => {
        events.push("categories");
      },
    },
    repository: {
      ensureDefaultPocket: async () => {
        events.push("pocket");
      },
    },
  });
  await service.ensureFinancialSetup("1");
  assert.deepEqual(events, ["categories", "pocket"]);
});

test("pocket list resolves a Telegram user and skips category default setup", async () => {
  const events: string[] = [];
  const pockets = [
    { id: "10", name: "Main Pocket", amount: null, isDefault: true },
  ];
  const { service } = createService({
    categoryService: {
      ensureDefaults: async () => {
        events.push("categories");
      },
    },
    repository: {
      findActiveUserIdByTelegramId: async (telegramUserId: string) => {
        events.push(`user:${telegramUserId}`);
        return "1";
      },
      ensureDefaultPocket: async (userId: string) => {
        events.push(`pocket:${userId}`);
      },
      listPockets: async (userId: string) => {
        events.push(`list:${userId}`);
        return pockets;
      },
    } as never,
  });

  const result = await service.listPockets({ userId: "976684739" });

  assert.deepEqual(result, { status: "ok", pockets });
  assert.deepEqual(events, ["user:976684739", "pocket:1", "list:1"]);
});

test("expense assignment runs first-use setup before resolving choices", async () => {
  const events: string[] = [];
  const { service } = createService({
    categoryService: {
      ensureDefaults: async () => {
        events.push("categories");
      },
      resolveForSave: async () => {
        events.push("resolve-category");
        return { category: "Food", needsReview: false };
      },
    },
    repository: {
      ensureDefaultPocket: async () => {
        events.push("pocket");
      },
      findDefaultPocket: async () => {
        events.push("resolve-pocket");
        return { id: "10", name: "Main Pocket", amount: null, isDefault: true };
      },
    },
  });

  await service.resolveExpenseAssignment({ userId: "1", category: "Food" });

  assert.deepEqual(events, [
    "categories",
    "pocket",
    "resolve-category",
    "resolve-pocket",
  ]);
});

test("explicit cross-user pocket throws NotFoundException", async () => {
  const { service } = createService({
    repository: { findPocket: async () => null },
  });
  await assert.rejects(
    () =>
      service.resolveExpenseAssignment({
        userId: "1",
        pocketId: "99",
        category: "Food",
      }),
    NotFoundException,
  );
});

test("explicit child pocket throws NotFoundException", async () => {
  const { service } = createService({
    repository: { findPocket: async () => null },
  });
  await assert.rejects(
    () =>
      service.resolveExpenseAssignment({
        userId: "1",
        pocketId: "child-9",
        category: "Food",
      }),
    NotFoundException,
  );
});

test("missing default returns awaiting_pocket with active choices", async () => {
  const pockets = [{ id: "10", name: "Main", amount: null, isDefault: false }];
  const { service } = createService({
    categoryService: {
      resolveForSave: async () => ({ category: "Food", needsReview: false }),
    },
    repository: {
      findDefaultPocket: async () => null,
    resolveLegacyPocketId: async () => "12",
      listPockets: async () => pockets,
    },
  });
  const result = await service.resolveExpenseAssignment({
    userId: "1",
    category: "Food",
  });
  assert.deepEqual(result, {
    status: "awaiting_pocket",
    category: "Food",
    needsCategoryReview: false,
    pockets,
  });
});

test("known category and default pocket resolve independently", async () => {
  const { service } = createService({
    categoryService: {
      resolveForSave: async () => ({ category: "Food", needsReview: false }),
    },
    repository: {
      findDefaultPocket: async () => ({
        id: "10",
        name: "Main Pocket",
        amount: null,
        isDefault: true,
      }),
    },
  });
  const result = await service.resolveExpenseAssignment({
    userId: "1",
    category: "Food",
  });
  assert.equal(result.status, "resolved");
  if (result.status === "resolved") assert.equal(result.pocketId, "10");
});

function createStateStore() {
  const calls: Array<{ method: string; request: unknown }> = [];

  return {
    calls,
    store: {
      upsertState: async (request: unknown) => {
        calls.push({ method: "upsertState", request });
        return {};
      },
      resetState: async (request: unknown) => {
        calls.push({ method: "resetState", request });
        return {};
      },
    },
  };
}

test("calculates a current cycle using the user cycle_start_day", () => {
  const { service } = createService();

  assert.deepEqual(
    service.calculateCurrentCycle(new Date("2026-06-17T08:00:00.000Z"), 15),
    {
      cycle_start: "2026-06-15",
      cycle_end: "2026-07-15",
    },
  );

  assert.deepEqual(
    service.calculateCurrentCycle(new Date("2026-06-14T08:00:00.000Z"), 15),
    {
      cycle_start: "2026-05-15",
      cycle_end: "2026-06-15",
    },
  );
});

test("clamps cycle_start_day to the last day of shorter months", () => {
  const { service } = createService();

  assert.deepEqual(
    service.calculateCurrentCycle(new Date("2026-03-30T08:00:00.000Z"), 31),
    {
      cycle_start: "2026-02-28",
      cycle_end: "2026-03-31",
    },
  );
});

test("maps budget status amounts and percentage", () => {
  const { service } = createService();

  const status = service.mapBudgetStatusRow(
    {
      budget_id: 42,
      category: "Food",
      parent_budget_id: null,
      budget_amount: "1500000",
      spent_amount: "375000",
      category_breakdown: [],
    },
    {
      cycle_start: "2026-06-15",
      cycle_end: "2026-07-15",
    },
  );

  assert.deepEqual(status, {
    budget_id: "42",
    category: "Food",
    parent_budget_id: null,
    budget_amount: 1500000,
    spent_amount: 375000,
    remaining_amount: 1125000,
    spent_percent: 25,
    category_breakdown: [],
    cycle_start: "2026-06-15",
    cycle_end: "2026-07-15",
  });
});

test("looks up user cycle then maps repository pocket status", async () => {
  const { calls, service } = createService([
    [{ cycle_start_day: 15 }],
    [
      {
        budget_id: "budget-1", category: "Food",
        parent_budget_id: null, budget_amount: "1000000",
        spent_amount: "250000",
      },
    ],
  ]);

  const status = await service.getBudgetStatus({
    telegramUserId: "telegram-123",
    category: "food",
    asOfDate: "2026-06-17",
  });

  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].values, ["telegram-123"]);
  assert.deepEqual(calls[1].values, [
    "telegram-123",
    null,
    "2026-06-15",
    "2026-07-15",
    "food",
  ]);
  assert.equal(calls[1].text, "findPocketStatus");
  assert.deepEqual(status, {
    budget_id: "budget-1",
    category: "Food",
    parent_budget_id: null,
    budget_amount: 1000000,
    spent_amount: 250000,
    remaining_amount: 750000,
    spent_percent: 25,
    category_breakdown: [],
    cycle_start: "2026-06-15",
    cycle_end: "2026-07-15",
  });
});

test("explicit pocket ID wins when category text collides with another pocket", async () => {
  const { calls, service } = createService([
    [{ cycle_start_day: 1 }],
    [
      {
        category: "42",
        parent_budget_id: null,
        spent_amount: "500000",
        category_breakdown: [],
      },
    ],
  ]);

  const result = await service.getBudgetStatus({
    userId: "1",
    pocketId: "42",
    category: "42",
    asOfDate: "2026-08-20",
  });

  assert.equal(result.spent_amount, 500000);
  assert.equal(calls[1].text, "findPocketStatus");
  assert.deepEqual(calls[1].values, [
    "1",
    "42",
    "2026-08-01",
    "2026-09-01",
    "42",
  ]);
});

test("returns pocket status with an empty category breakdown", async () => {
  const { service } = createService([
    [{ cycle_start_day: 1 }],
    [
      {
        budget_id: "budget-food",
        category: "Food",
        parent_budget_id: null,
        budget_amount: "2000000",
        spent_amount: "500000",
        category_breakdown: [],
      },
    ],
  ]);

  const status = await service.getBudgetStatus({
    userId: "user-1",
    category: "Food",
    asOfDate: "2026-06-17",
  });

  assert.deepEqual(status, {
    budget_id: "budget-food",
    category: "Food",
    parent_budget_id: null,
    budget_amount: 2000000,
    spent_amount: 500000,
    remaining_amount: 1500000,
    spent_percent: 25,
    category_breakdown: [],
    cycle_start: "2026-06-01",
    cycle_end: "2026-07-01",
  });
});

test("returns pocket status with all category spending", async () => {
  const { service } = createService([
    [{ cycle_start_day: 1 }],
    [
      {
        budget_id: "budget-living", category: "Living",
        parent_budget_id: null, budget_amount: "3000000",
        spent_amount: "1500000",
        category_breakdown: [
          {
            category: "Food",
            spent_amount: "1250000",
          },
          {
            category: "Transport",
            spent_amount: "250000",
          },
        ],
      },
    ],
  ]);

  const status = await service.getBudgetStatus({
    userId: "user-1",
    category: "Living",
    asOfDate: "2026-06-17",
  });

  assert.deepEqual(status, {
    budget_id: "budget-living",
    category: "Living",
    parent_budget_id: null,
    budget_amount: 3000000,
    spent_amount: 1500000,
    remaining_amount: 1500000,
    spent_percent: 50,
    category_breakdown: [
      {
        category: "Food",
        spent_amount: 1250000,
      },
      {
        category: "Transport",
        spent_amount: 250000,
      },
    ],
    cycle_start: "2026-06-01",
    cycle_end: "2026-07-01",
  });
});

test("rejects missing budget status category", async () => {
  const { service } = createService();

  await assert.rejects(
    () =>
      service.getBudgetStatus({
        userId: "user-1",
        category: " ",
      }),
    BadRequestException,
  );
});

test("returns not found for inactive or missing category", async () => {
  const { service } = createService([[{ cycle_start_day: 1 }], []]);

  await assert.rejects(
    () =>
      service.getBudgetStatus({
        userId: "user-1",
        category: "Inactive Food",
        asOfDate: "2026-06-17",
      }),
    NotFoundException,
  );
});

test("uses custom cycle day for budget status lookup", async () => {
  const { calls, service } = createService([
    [{ cycle_start_day: 20 }],
    [
      {
        budget_id: "budget-food",
        category: "Food",
        parent_budget_id: null,
        budget_amount: "1000000",
        spent_amount: "100000",
        category_breakdown: "[]",
      },
    ],
  ]);

  const status = await service.getBudgetStatus({
    userId: "user-1",
    category: "Food",
    asOfDate: "2026-06-17",
  });

  assert.deepEqual(calls[1].values, [
    "user-1",
    null,
    "2026-05-20",
    "2026-06-20",
    "Food",
  ]);
  assert.equal(status.cycle_start, "2026-05-20");
  assert.equal(status.cycle_end, "2026-06-20");
});

test("lists active budget categories with parent category names", async () => {
  const { calls, service } = createService([
    [
      {
        id: 12,
        category: "Food",
        parent_category: "Monthly Allowance",
      },
      {
        id: 13,
        category: "Transport",
        parent_category: "Monthly Allowance",
      },
      {
        id: 18,
        category: "Netflix",
        parent_category: "Subscription",
      },
      {
        id: 21,
        category: "Health",
        parent_category: null,
      },
    ],
  ]);

  const result = await service.getBudgetCategories({ userId: 1 });

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].values, ["1"]);
  assert.match(calls[0].text, /FROM budgets b/);
  assert.match(
    calls[0].text,
    /LEFT JOIN budgets parent ON parent\.id = b\.parent_budget_id/,
  );
  assert.match(calls[0].text, /COALESCE\(b\.is_active, true\) = true/);
  assert.deepEqual(result, {
    status: "ok",
    categories: [
      {
        id: 12,
        category: "Food",
        parent_category: "Monthly Allowance",
      },
      {
        id: 13,
        category: "Transport",
        parent_category: "Monthly Allowance",
      },
      {
        id: 18,
        category: "Netflix",
        parent_category: "Subscription",
      },
      {
        id: 21,
        category: "Health",
        parent_category: null,
      },
    ],
  });
});

test("requires userId to list budget categories", async () => {
  const { calls, service } = createService();

  await assert.rejects(
    service.getBudgetCategories({ userId: "" }),
    BadRequestException,
  );
  assert.equal(calls.length, 0);
});

test("upserts a budget for a resolved Telegram user", async () => {
  const { calls, service } = createService({
    rowsByCall: [
      [
        {
          budget_id: "budget-1",
          user_id: "internal-1",
          category: "Food",
          amount: "1500000",
          parent_budget_id: null,
          parent_category: null,
          period_type: "monthly",
          inserted: true,
        },
      ],
    ],
    repository: {
      findActiveUserIdByTelegramId: async () => "internal-1",
    },
  });

  const result = await service.upsertBudget({
    telegramUserId: "976684739",
    category: "Food",
    amount: 1500000,
  });

  assert.equal(calls[0]?.values[0], "internal-1");
  assert.equal(result.user_id, "internal-1");
});

test("renames a pocket for a resolved Telegram user", async () => {
  const events: string[] = [];
  const pocket = { id: "42", name: "Food", amount: null, isDefault: false };
  const { service } = createService({
    categoryService: {
      ensureDefaults: async () => {
        events.push("categories");
      },
    },
    repository: {
      findActiveUserIdByTelegramId: async (telegramUserId: string) => {
        events.push(`resolve:${telegramUserId}`);
        return "internal-1";
      },
      ensureDefaultPocket: async (userId: string) => {
        events.push(`setup:${userId}`);
      },
      renamePocket: async (userId: string) => {
        events.push(`rename:${userId}`);
        return pocket;
      },
    },
  });

  assert.deepEqual(
    await service.renamePocket({
      telegramUserId: "976684739",
      pocketId: "42",
      name: "Food",
    }),
    pocket,
  );
  assert.deepEqual(events, [
    "resolve:976684739",
    "categories",
    "setup:internal-1",
    "rename:internal-1",
  ]);
});

test("sets a default pocket for a resolved Telegram user", async () => {
  const events: string[] = [];
  const pocket = { id: "42", name: "Food", amount: null, isDefault: true };
  const { service } = createService({
    categoryService: {
      ensureDefaults: async () => {
        events.push("categories");
      },
    },
    repository: {
      findActiveUserIdByTelegramId: async (telegramUserId: string) => {
        events.push(`resolve:${telegramUserId}`);
        return "internal-1";
      },
      ensureDefaultPocket: async (userId: string) => {
        events.push(`setup:${userId}`);
      },
      setDefaultPocket: async (userId: string) => {
        events.push(`default:${userId}`);
        return pocket;
      },
    },
  });

  assert.deepEqual(
    await service.setDefaultPocket({
      telegramUserId: "976684739",
      pocketId: "42",
    }),
    pocket,
  );
  assert.deepEqual(events, [
    "resolve:976684739",
    "categories",
    "setup:internal-1",
    "default:internal-1",
  ]);
});

for (const [label, request] of [
  ["neither identity", { category: "Food", amount: 1500000 }],
  [
    "both identities",
    {
      userId: "internal-1",
      telegramUserId: "976684739",
      category: "Food",
      amount: 1500000,
    },
  ],
] as const) {
  test(`rejects budget upsert with ${label}`, async () => {
    const { calls, service } = createService();

    await assert.rejects(
      service.upsertBudget(request),
      (error: unknown) =>
        error instanceof BadRequestException &&
        error.message === "Provide exactly one userId or telegramUserId",
    );
    assert.equal(calls.length, 0);
  });
}

for (const [label, write] of [
  [
    "budget upsert",
    (service: BudgetService) =>
      service.upsertBudget({
        telegramUserId: "missing",
        category: "Food",
        amount: 1500000,
      }),
  ],
  [
    "pocket rename",
    (service: BudgetService) =>
      service.renamePocket({
        telegramUserId: "missing",
        pocketId: "42",
        name: "Food",
      }),
  ],
  [
    "default pocket",
    (service: BudgetService) =>
      service.setDefaultPocket({ telegramUserId: "missing", pocketId: "42" }),
  ],
] as const) {
  test(`${label} rejects an unknown Telegram user before mutations`, async () => {
    const events: string[] = [];
    const { calls, service } = createService({
      categoryService: {
        ensureDefaults: async () => {
          events.push("categories");
        },
      },
      repository: {
        findActiveUserIdByTelegramId: async () => {
          events.push("resolve");
          return null;
        },
        ensureDefaultPocket: async () => {
          events.push("setup");
        },
        renamePocket: async () => {
          events.push("rename");
          return null;
        },
        setDefaultPocket: async () => {
          events.push("default");
          return null;
        },
      },
    });

    await assert.rejects(
      write(service),
      (error: unknown) =>
        error instanceof NotFoundException &&
        error.message === "Telegram user not found",
    );
    assert.deepEqual(events, ["resolve"]);
    assert.equal(calls.length, 0);
  });
}

test("creates a budget without parent", async () => {
  const { calls, service } = createService([
    [
      {
        budget_id: "budget-1",
        user_id: "user-1",
        category: "Food",
        amount: "1500000",
        parent_budget_id: null,
        parent_category: null,
        period_type: "monthly",
        inserted: true,
      },
    ],
  ]);

  const result = await service.upsertBudget({
    userId: "user-1",
    category: "Food",
    amount: 1500000,
  });

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].values, [
    "user-1",
    "Food",
    1500000,
    "monthly",
  ]);
  assert.doesNotMatch(calls[0].text, /ON CONFLICT/);
  assert.match(calls[0].text, /WITH existing_budget AS/);
  assert.match(
    calls[0].text,
    /SELECT \$1::bigint, \$2, \$3, NULL, \$4, true/,
  );
  assert.match(calls[0].text, /\bamount,\s+parent_budget_id,/);
  assert.match(calls[0].text, /changed_budget\.amount/);
  assert.doesNotMatch(calls[0].text, /budget_amount/);
  assert.deepEqual(result, {
    budget_id: "budget-1",
    user_id: "user-1",
    category: "Food",
    amount: 1500000,
    parent_budget_id: null,
    parent_category: null,
    period_type: "monthly",
    action: "created",
  });
});





test("updates an existing budget", async () => {
  const { service } = createService([
    [
      {
        budget_id: "budget-1",
        user_id: "user-1",
        category: "Food",
        amount: "1750000",
        parent_budget_id: null,
        parent_category: null,
        period_type: "monthly",
        inserted: false,
      },
    ],
  ]);

  const result = await service.upsertBudget({
    userId: "user-1",
    category: "Food",
    amount: 1750000,
    periodType: "monthly",
  });

  assert.equal(result.action, "updated");
  assert.equal(result.amount, 1750000);
});

test("updates amount using the production budget amount column", async () => {
  const { calls, service } = createService([
    [
      {
        budget_id: "budget-1",
        user_id: "user-1",
        category: "Food",
        amount: "1750000",
        parent_budget_id: null,
        parent_category: null,
        period_type: "monthly",
        inserted: false,
      },
    ],
  ]);

  const result = await service.upsertBudget({
    userId: "user-1",
    category: "Food",
    amount: 1750000,
    periodType: "monthly",
  });

  assert.match(calls[0].text, /UPDATE budgets/);
  assert.match(calls[0].text, /amount = \$3/);
  assert.doesNotMatch(calls[0].text, /updated_at/);
  assert.doesNotMatch(calls[0].text, /budget_amount/);
  assert.equal(result.action, "updated");
  assert.equal(result.amount, 1750000);
});

test("budget updates select only pockets even when a legacy child has the same name", async () => {
  const { calls, service } = createService([[{
    budget_id: "42", user_id: "1", category: "Food", amount: "1250000",
    parent_budget_id: null, parent_category: null, period_type: "monthly", inserted: false,
  }]]);
  const result = await service.upsertBudget({ userId: "1", category: "Food", amount: 1250000 });
  assert.match(calls[0].text, /AND parent_budget_id IS NULL/);
  assert.deepEqual(calls[0].values, ["1", "Food", 1250000, "monthly"]);
  assert.equal(result.parent_budget_id, null);
});

test("rejects invalid budget amount", async () => {
  const { service } = createService();

  await assert.rejects(
    () =>
      service.upsertBudget({
        userId: "user-1",
        category: "Food",
        amount: 0,
      }),
    BadRequestException,
  );
});



test("budget handle complete status resets state and returns status message", async () => {
  const { service } = createService([
    [{ cycle_start_day: 15 }],
    [
      {
        budget_id: "budget-food",
        category: "Food",
        parent_budget_id: null,
        budget_amount: "1000000",
        spent_amount: "250000",
        category_breakdown: [
          {
            category: "Snacks",
            spent_amount: "50000",
          },
        ],
      },
    ],
  ]);
  const state = createStateStore();

  const result = await service.handleBudgetRequest(
    {
      telegramUserId: "123456789",
      userId: 1,
      text: "status Food",
      statePayload: {},
      llmResult: {
        intent: "budget_status",
        category: "Food",
      },
    },
    state.store,
  );

  assert.equal(result.state.nextState, "idle");
  assert.deepEqual(result.state.payload, {});
  assert.equal(state.calls[0].method, "resetState");
  assert.match(result.message.text, /Budget status\./);
  assert.match(result.message.text, /Category: Food/);
  assert.match(result.message.text, /Budget: Rp1\.000\.000/);
  assert.match(result.message.text, /Spent: Rp250\.000/);
  assert.doesNotMatch(result.message.text, /cycle_start|cycle_end|2026-06-15/);
  assert.deepEqual(result.data.intent, "budget_status");
});

test("budget overview lists only pocket limits and omits legacy children", async () => {
  const { calls, service } = createService([
    [{ cycle_start_day: 15 }],
    [
      {
        budget_id: "parent-1",
        category: "Monthly Allowance",
        parent_budget_id: null,
        parent_category: null,
        amount: "4000000",
        spent_amount: "2000000",
        child_count: "2",
      },
      {
        budget_id: "parent-2",
        category: "Subscription",
        parent_budget_id: null,
        parent_category: null,
        amount: "37200",
        spent_amount: "37200",
        child_count: "1",
      },
      {
        budget_id: "top-1",
        category: "Health",
        parent_budget_id: null,
        parent_category: null,
        amount: "500000",
        spent_amount: "125000",
        child_count: "0",
      },
      {
        budget_id: "child-food",
        category: "Food",
        parent_budget_id: "parent-1",
        parent_category: "Monthly Allowance",
        amount: "2000000",
        spent_amount: "1000000",
        child_count: "0",
      },
      {
        budget_id: "child-transport",
        category: "Transport",
        parent_budget_id: "parent-1",
        parent_category: "Monthly Allowance",
        amount: "2000000",
        spent_amount: "1000000",
        child_count: "0",
      },
      {
        budget_id: "child-netflix",
        category: "Netflix",
        parent_budget_id: "parent-2",
        parent_category: "Subscription",
        amount: "37200",
        spent_amount: "37200",
        child_count: "0",
      },
    ],
  ]);
  const state = createStateStore();

  const result = await service.handleBudgetRequest(
    {
      telegramUserId: "123456789",
      userId: 1,
      text: "show all budgets",
      statePayload: {},
      llmResult: {
        intent: "budget_overview",
      },
    },
    state.store,
  );

  assert.equal(calls.length, 2);
  assert.equal(calls[1].values[0], "1");
  assert.match(String(calls[1].values[1]), /^\d{4}-\d{2}-\d{2}$/);
  assert.match(String(calls[1].values[2]), /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(calls[1].text, "listPocketOverview");
  assert.equal(state.calls[0].method, "resetState");
  assert.equal(result.state.nextState, "idle");
  assert.deepEqual(result.state.payload, {});
  assert.deepEqual(result.data.intent, "budget_overview");
  assert.deepEqual(result.data.messages, [result.message.text]);
  assert.equal(result.data.message, result.message.text);
  assert.match(result.message.text, /📊 Budget Overview/);
  assert.match(
    result.message.text,
    /Monthly Allowance - Rp2\.000\.000 \/ Rp4\.000\.000/,
  );
  assert.doesNotMatch(result.message.text, /├ Food — Rp1\.000\.000 \/ Rp2\.000\.000/);
  assert.doesNotMatch(result.message.text, /Transport — Rp1\.000\.000 \/ Rp2\.000\.000/);
  assert.match(result.message.text, /Subscription - Rp37\.200 \/ Rp37\.200/);
  assert.doesNotMatch(result.message.text, /└ Netflix — Rp37\.200 \/ Rp37\.200/);
  assert.match(result.message.text, /Health - Rp125\.000 \/ Rp500\.000/);
});

test("budget overview returns empty-state message when no active budgets exist", async () => {
  const { service } = createService([[{ cycle_start_day: 1 }], []]);
  const state = createStateStore();

  const result = await service.handleBudgetRequest(
    {
      userId: 1,
      statePayload: {},
      llmResult: {
        intent: "budget_overview",
      },
    },
    state.store,
  );

  assert.equal(
    result.message.text,
    "No active budgets yet. Set one when you are ready.",
  );
  assert.deepEqual(result.data, {
    intent: "budget_overview",
    messages: ["No active budgets yet. Set one when you are ready."],
    message: "No active budgets yet. Set one when you are ready.",
  });
  assert.equal(state.calls[0].method, "resetState");
});

test("budget overview splits long output into multiple messages by budget group", async () => {
  const rows = Array.from({ length: 170 }, (_, index) => ({
    budget_id: `budget-${index}`,
    category: `Very Long Budget Category ${String(index).padStart(3, "0")}`,
    parent_budget_id: null,
    parent_category: null,
    amount: "1000000",
    spent_amount: "250000",
    child_count: "0",
  }));
  const { service } = createService([[{ cycle_start_day: 1 }], rows]);
  const state = createStateStore();

  const result = await service.handleBudgetRequest(
    {
      userId: 1,
      statePayload: {},
      llmResult: {
        intent: "budget_overview",
      },
    },
    state.store,
  );

  const messages = result.data.messages as string[];

  assert.ok(messages.length > 1);
  messages.forEach((message) => {
    assert.ok(message.length <= 3500);
    assert.match(message, /📊 Budget Overview/);
  });
  assert.equal(result.message.text, messages[0]);
  assert.equal(result.data.message, messages[0]);
});

test("budget handle incomplete set budget saves pending state and asks amount", async () => {
  const { service } = createService();
  const state = createStateStore();

  const result = await service.handleBudgetRequest(
    {
      userId: 1,
      text: "set Food budget",
      statePayload: {},
      llmResult: {
        intent: "set_budget",
        category: "Food",
        missing_fields: ["amount"],
      },
    },
    state.store,
  );

  assert.equal(result.state.nextState, "budget_conversation_state");
  assert.deepEqual(result.state.payload, {
    intent: "set_budget",
    category: "Food",
    missing_fields: ["amount"],
    pending: true,
  });
  assert.deepEqual(state.calls, [
    {
      method: "upsertState",
      request: {
        userId: 1,
        stateName: "budget_conversation_state",
        stateData: result.state.payload,
      },
    },
  ]);
  assert.equal(result.message.text, "How much for Food?");
});

test("budget handle follow-up amount merges pending state and calls upsert", async () => {
  const { calls, service } = createService([
    [
      {
        budget_id: "budget-1",
        user_id: "1",
        category: "Food",
        amount: "1000000",
        parent_budget_id: null,
        parent_category: null,
        period_type: "monthly",
        inserted: false,
      },
    ],
  ]);
  const state = createStateStore();

  const result = await service.handleBudgetRequest(
    {
      userId: 1,
      text: "1 juta",
      statePayload: {
        intent: "set_budget",
        category: "Food",
        pending: true,
        missing_fields: ["amount"],
      },
      llmResult: {
        intent: "unknown",
        amount: 1000000,
        missing_fields: [],
      },
    },
    state.store,
  );

  assert.deepEqual(calls[0].values, [
    "1",
    "Food",
    1000000,
    "monthly",
  ]);
  assert.equal(state.calls[0].method, "resetState");
  assert.equal(result.state.nextState, "idle");
  assert.match(result.message.text, /Budget updated\./);
  assert.match(result.message.text, /Amount: Rp1\.000\.000/);
  assert.equal(result.data.intent, "set_budget");
});

test("budget handle parses a missing LLM result and merges the pending state", async () => {
  const parsedInputs: unknown[] = [];
  const { calls, service } = createService({
    rowsByCall: [
      [
        {
          budget_id: "budget-1",
          user_id: "1",
          category: "Food",
          amount: "1000000",
          parent_budget_id: null,
          parent_category: null,
          period_type: "monthly",
          inserted: false,
        },
      ],
    ],
    veyraAiService: {
      parseBudgetIntent: async (input: unknown) => {
        parsedInputs.push(input);
        return {
          intent: "unknown",
          category: null,
          parent_category: null,
          amount: 1000000,
          missing_fields: [],
        };
      },
    },
  });
  const state = createStateStore();
  const statePayload = {
    intent: "set_budget",
    category: "Food",
    pending: true,
    missing_fields: ["amount"],
  };

  const result = await service.handleBudgetRequest(
    { userId: 1, text: "1 juta", statePayload },
    state.store,
  );

  assert.deepEqual(parsedInputs, [{ text: "1 juta", statePayload }]);
  assert.deepEqual(calls[0].values, [
    "1",
    "Food",
    1000000,
    "monthly",
  ]);
  assert.equal(result.data.intent, "set_budget");
  assert.equal(state.calls[0].method, "resetState");
});

test("budget handle keeps caller-provided LLM result as the rollback path", async () => {
  let parserCalls = 0;
  const { service } = createService({
    veyraAiService: {
      parseBudgetIntent: async () => {
        parserCalls += 1;
        throw new Error("should not run");
      },
    },
  });
  const state = createStateStore();

  const result = await service.handleBudgetRequest(
    {
      userId: 1,
      text: "show my budgets",
      llmResult: { intent: "unknown" },
    },
    state.store,
  );

  assert.equal(parserCalls, 0);
  assert.equal(result.data.intent, "unknown");
  assert.equal(state.calls[0].method, "resetState");
});

test("budget handle requires text when its LLM result is absent", async () => {
  let parserCalls = 0;
  const { calls, service } = createService({
    veyraAiService: {
      parseBudgetIntent: async () => {
        parserCalls += 1;
        return {
          intent: "unknown",
          category: null,
          parent_category: null,
          amount: null,
          missing_fields: [],
        };
      },
    },
  });
  const state = createStateStore();

  await assert.rejects(
    () => service.handleBudgetRequest({ userId: 1 }, state.store),
    /text is required when llmResult is absent/,
  );

  assert.equal(parserCalls, 0);
  assert.equal(calls.length, 0);
  assert.deepEqual(state.calls, []);
});

test("budget handle set sub budget without parent explains pocket-only limits", async () => {
  const { calls, service } = createService();
  const state = createStateStore();
  const result = await service.handleBudgetRequest({
    userId: "1", llmResult: { intent: "set_sub_budget", category: "Food", amount: 1000000,  },
  }, state.store);
  assert.equal(result.state.nextState, "idle");
  assert.match(result.message.text, /Set the budget on the pocket itself/);
  assert.equal(calls.length, 0);
});

test("budget handle complete set sub budget does not create child rows", async () => {
  const { calls, service } = createService();
  const state = createStateStore();
  const result = await service.handleBudgetRequest({
    userId: "1", llmResult: { intent: "set_sub_budget", category: "Food", amount: 1000000, parent_category: "Living", },
  }, state.store);
  assert.equal(result.state.nextState, "idle");
  assert.match(result.message.text, /Set the budget on the pocket itself/);
  assert.equal(calls.length, 0);
});

test("budget handle reset and cancel set idle", async () => {
  const { service } = createService();
  const resetState = createStateStore();
  const cancelState = createStateStore();

  const resetResult = await service.handleBudgetRequest(
    {
      userId: 1,
      statePayload: { intent: "set_budget", category: "Food", pending: true },
      llmResult: { intent: "reset" },
    },
    resetState.store,
  );
  const cancelResult = await service.handleBudgetRequest(
    {
      userId: 1,
      text: "batal",
      statePayload: { intent: "set_budget", category: "Food", pending: true },
      llmResult: { intent: "unknown" },
    },
    cancelState.store,
  );

  assert.equal(resetResult.state.nextState, "idle");
  assert.deepEqual(resetResult.state.payload, {});
  assert.equal(cancelResult.state.nextState, "idle");
  assert.deepEqual(cancelResult.state.payload, {});
  assert.equal(resetState.calls[0].method, "resetState");
  assert.equal(cancelState.calls[0].method, "resetState");
  assert.equal(cancelResult.message.text, "Budget action cancelled.");
});

test("budget handle delete intent returns not wired and sets idle", async () => {
  const { service } = createService();
  const state = createStateStore();

  const result = await service.handleBudgetRequest(
    {
      userId: 1,
      statePayload: {},
      llmResult: {
        intent: "delete_budget",
        category: "Food",
      },
    },
    state.store,
  );

  assert.equal(result.state.nextState, "idle");
  assert.deepEqual(result.state.payload, {});
  assert.equal(state.calls[0].method, "resetState");
  assert.equal(result.message.text, "Delete not wired yet. Budget unchanged.");
  assert.deepEqual(result.data, {
    intent: "delete_budget",
    category: "Food",
    parent_category: null,
  });
});

test("budget handle unknown intent resets state with short clarification", async () => {
  const { service } = createService();
  const state = createStateStore();

  const result = await service.handleBudgetRequest(
    {
      userId: 1,
      text: "wat",
      statePayload: {},
      llmResult: { intent: "unknown" },
    },
    state.store,
  );

  assert.equal(result.state.nextState, "idle");
  assert.deepEqual(result.state.payload, {});
  assert.equal(state.calls[0].method, "resetState");
  assert.equal(
    result.message.text,
    "What do you want to do: show or set a budget?",
  );
  assert.deepEqual(result.data, { intent: "unknown" });
});

test("does not alert below 75 percent spending", async () => {
  const { calls, service } = createService([
    [{ cycle_start_day: 15 }],
    [
      {
        budget_id: "budget-1",
        category: "Food",
        parent_budget_id: null,
        budget_amount: "1000000",
        spent_amount: "740000",
      },
    ],
  ]);

  const result = await service.checkOverspending({
    userId: "user-1",
    category: "Food",
  });
  const cycle = service.calculateCurrentCycle(new Date(), 15);

  assert.equal(calls.length, 2);
  assert.equal(result.shouldAlert, false);
  assert.equal(result.alreadyAlerted, false);
  assert.equal(result.alertType, null);
  assert.equal(result.telegramHtml, null);
  assert.equal(result.alertRecord, null);
  assert.equal(result.spentPercent, 74);
  assert.equal(
    result.periodKey,
    service.periodKeyFromCycleStart(cycle.cycle_start),
  );
});

test("does not alert at 74.9 percent spending", async () => {
  const { service } = createService([
    [{ cycle_start_day: 15 }],
    [
      {
        budget_id: "budget-1",
        category: "Food",
        parent_budget_id: null,
        budget_amount: "1000000",
        spent_amount: "749000",
      },
    ],
  ]);

  const result = await service.checkOverspending({
    userId: "user-1",
    category: "Food",
  });

  assert.equal(result.shouldAlert, false);
  assert.equal(result.alertType, null);
  assert.equal(result.spentPercent, 74.9);
});

test("alerts at 80 percent spending", async () => {
  const { calls, service } = createService([
    [{ cycle_start_day: 15 }],
    [
      {
        budget_id: "budget-1",
        category: "Food",
        parent_budget_id: null,
        budget_amount: "1000000",
        spent_amount: "800000",
      },
    ],
    [{ exists: false }],
  ]);

  const result = await service.checkOverspending({
    userId: "user-1",
    category: "Food",
  });
  const cycle = service.calculateCurrentCycle(new Date(), 15);
  const periodKey = service.periodKeyFromCycleStart(cycle.cycle_start);

  assert.equal(calls.length, 3);
  assert.doesNotMatch(calls[1].text, /budget_scope/);
  assert.equal(calls[1].text, "findPocketStatus");

  assert.deepEqual(calls[2].values, [
    "user-1",
    "budget-1",
    "budget_75",
    periodKey,
  ]);
  assert.equal(result.shouldAlert, true);
  assert.equal(result.alreadyAlerted, false);
  assert.equal(result.alertType, "budget_75");
  assert.deepEqual(result.alertRecord, {
    budgetId: "budget-1",
    alertType: "budget_75",
    periodKey,
  });
  assert.match(result.telegramHtml ?? "", /<b>Budget warning<\/b>/);
  assert.match(result.telegramHtml ?? "", /Category: <b>Food<\/b>/);
});

test("overspending accepts pocketId and uses pocket-first status", async () => {
  const { calls, service } = createService([
    [{ cycle_start_day: 1 }],
    [
      {
        budget_id: "42",
        category: "Monthly Transactions",
        parent_budget_id: null,
        budget_amount: "1000000",
        spent_amount: "100000",
        category_breakdown: [],
      },
    ],
  ]);

  const result = await service.checkOverspending({
    userId: "1",
    pocketId: "42",
  });

  assert.equal(result.budgetId, "42");
  assert.deepEqual(calls[1].values.slice(0, 2), ["1", "42"]);
  assert.equal(calls[1].text, "findPocketStatus");
});

test("alerts at 100 percent spending", async () => {
  const { service } = createService([
    [{ cycle_start_day: 15 }],
    [
      {
        budget_id: "budget-1",
        category: "Food",
        parent_budget_id: null,
        budget_amount: "1000000",
        spent_amount: "1000000",
      },
    ],
    [{ exists: false }],
  ]);

  const result = await service.checkOverspending({
    userId: "user-1",
    category: "Food",
  });

  assert.equal(result.shouldAlert, true);
  assert.equal(result.alertType, "budget_100");
  assert.equal(result.spentPercent, 100);
});

test("alerts at 120 percent spending", async () => {
  const { service } = createService([
    [{ cycle_start_day: 15 }],
    [
      {
        budget_id: "budget-1",
        category: "Food",
        parent_budget_id: null,
        budget_amount: "1000000",
        spent_amount: "1200000",
      },
    ],
    [{ exists: false }],
  ]);

  const result = await service.checkOverspending({
    userId: "user-1",
    category: "Food",
  });

  assert.equal(result.shouldAlert, true);
  assert.equal(result.alertType, "budget_100");
  assert.equal(result.remainingAmount, -200000);
});

test("uses full cycle start date as overspending period key", async () => {
  const { service } = createService([
    [{ cycle_start_day: 15 }],
    [
      {
        budget_id: "budget-1",
        category: "Food",
        parent_budget_id: null,
        budget_amount: "1000000",
        spent_amount: "800000",
      },
    ],
    [{ exists: false }],
  ]);

  const result = await service.checkOverspending({
    userId: "user-1",
    category: "Food",
  });

  assert.match(result.periodKey, /^\d{4}-\d{2}-\d{2}$/);
});

test("does not alert again when duplicate budget alert exists", async () => {
  const { service } = createService([
    [{ cycle_start_day: 15 }],
    [
      {
        budget_id: "budget-1",
        category: "Food",
        parent_budget_id: null,
        budget_amount: "1000000",
        spent_amount: "854000",
      },
    ],
    [{ exists: true }],
  ]);

  const result = await service.checkOverspending({
    userId: "user-1",
    category: "Food",
  });
  const cycle = service.calculateCurrentCycle(new Date(), 15);
  const periodKey = service.periodKeyFromCycleStart(cycle.cycle_start);

  assert.deepEqual(result, {
    shouldAlert: false,
    alreadyAlerted: true,
    alertType: "budget_75",
    telegramHtml: null,
    alertRecord: {
      budgetId: "budget-1",
      alertType: "budget_75",
      periodKey,
    },
    budgetId: "budget-1",
    userId: "user-1",
    category: "Food",
    spentPercent: 85.4,
    spentAmount: 854000,
    budgetAmount: 1000000,
    remainingAmount: 146000,
    cycleStart: cycle.cycle_start,
    cycleEnd: cycle.cycle_end,
    periodKey,
  });
});

test("propagates missing budget errors during overspending check", async () => {
  const { service } = createService([[{ cycle_start_day: 15 }], []]);

  await assert.rejects(
    () =>
      service.checkOverspending({
        userId: "user-1",
        category: "Missing",
      }),
    NotFoundException,
  );
});

test("overspending handle returns no_alert without checking alert records below threshold", async () => {
  const { calls, service } = createService([
    [{ cycle_start_day: 25 }],
    [
      {
        budget_id: "12",
        category: "Food",
        parent_budget_id: null,
        budget_amount: "1000000",
        spent_amount: "425000",
      },
    ],
  ]);

  const result = await service.handleOverspending({
    userId: 1,
    category: "Food",
    asOfDate: "2026-06-25",
  });

  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].values, ["1", null, "2026-06-25", "2026-07-25", "Food"]);
  assert.deepEqual(result, {
    ok: true,
    status: "no_alert",
    shouldAlert: false,
    alreadyAlerted: false,
    message: null,
    data: {
      transactionId: undefined,
      userId: "1",
      budgetId: "12",
      category: "Food",
      spentPercent: 42.5,
      spentAmount: 425000,
      budgetAmount: 1000000,
      remainingAmount: 575000,
      cycleStart: "2026-06-25",
      cycleEnd: "2026-07-25",
    },
  });
});



test("watchdog returns forecast facts without recording before delivery", async () => {
  const previousUrl = process.env.VEYRA_MINI_APP_BASE_URL;
  process.env.VEYRA_MINI_APP_BASE_URL = "https://t.me/veyra/app";

  try {
    const { calls, service } = createService([
      [
        {
          id: 123,
          user_id: 1,
          transaction_type: "expense",
          category: "Dining",
          status: "confirmed",
          transaction_date: "2026-08-20T12:00:00.000Z",
          pocket_id: "42",
        },
      ],
      [{ cycle_start_day: 1 }],
      [
        {
          budget_id: "42",
          category: "Food",
          parent_budget_id: null,
          budget_amount: "1500000",
          spent_amount: "1000000",
          category_breakdown: [
            {
              category: "Dining",
              spent_amount: "600000",
            },
          ],
        },
      ],
      [{ exists: false }],
    ]);

    const result = await service.evaluateTransaction({
      userId: 1,
      transactionId: 123,
      timezone: "Asia/Jakarta",
    });
    const alert = result.alerts[0];

    assert.equal(calls.length, 4);
    assert.equal(
      calls.some(({ text }) => /INSERT INTO budget_alerts/.test(text)),
      false,
    );
    assert.deepEqual(alert, {
      type: "budget_forecast_overrun",
      budgetId: "42",
      category: "Food",
      usedPercent: 66.67,
      remainingAmount: 500000,
      safeDailySpend: 45454,
      projectedCycleSpend: 1550000,
      projectedOverrun: 50000,
      topDriver: { category: "Dining", amount: 600000 },
      telegramText: [
        "Food may exceed its budget by Rp50.000 this cycle.",
        "Rp1.000.000 spent of Rp1.500.000.",
        "Safe daily spend: Rp45.454.",
        "Top driver: Dining (Rp600.000).",
      ].join("\n"),
      miniAppUrl: "https://t.me/veyra/app?startapp=pocket_42",
      alertRecord: {
        userId: "1",
        budgetId: "42",
        alertType: "budget_forecast_overrun",
        thresholdPercent: 0,
        periodKey: "2026-08-01",
      },
    });
  } finally {
    if (previousUrl === undefined) delete process.env.VEYRA_MINI_APP_BASE_URL;
    else process.env.VEYRA_MINI_APP_BASE_URL = previousUrl;
  }
});

test("watchdog suppresses an already recorded forecast", async () => {
  const { service } = createService([
    [
      {
        id: 123,
        user_id: 1,
        transaction_type: "expense",
        category: "Food",
        status: "confirmed",
        transaction_date: "2026-08-20T12:00:00.000Z",
        pocket_id: "42",
      },
    ],
    [{ cycle_start_day: 1 }],
    [
      {
        budget_id: "42",
        category: "Food",
        parent_budget_id: null,
        budget_amount: "1500000",
        spent_amount: "1000000",
        category_breakdown: [],
      },
    ],
    [{ exists: true }],
  ]);

  const result = await service.evaluateTransaction({
    userId: 1,
    transactionId: 123,
    timezone: "Asia/Jakarta",
  });

  assert.deepEqual(result.alerts, []);
  assert.equal(result.hasAlert, false);
});

test("watchdog keeps forecast text when Mini App URL is missing", async () => {
  const previousUrl = process.env.VEYRA_MINI_APP_BASE_URL;
  delete process.env.VEYRA_MINI_APP_BASE_URL;

  try {
    const { service } = createService([
      [
        {
          id: 123,
          user_id: 1,
          transaction_type: "expense",
          category: "Food",
          status: "confirmed",
          transaction_date: "2026-08-20T12:00:00.000Z",
          pocket_id: "42",
        },
      ],
      [{ cycle_start_day: 1 }],
      [
        {
          budget_id: "42",
          category: "Food",
          parent_budget_id: null,
          budget_amount: "1500000",
          spent_amount: "1000000",
          category_breakdown: [],
        },
      ],
      [{ exists: false }],
    ]);

    const result = await service.evaluateTransaction({
      userId: 1,
      transactionId: 123,
      timezone: "Asia/Jakarta",
    });

    assert.match(result.alerts[0]?.telegramText ?? "", /may exceed/);
    assert.equal(result.alerts[0]?.miniAppUrl, null);
  } finally {
    if (previousUrl !== undefined)
      process.env.VEYRA_MINI_APP_BASE_URL = previousUrl;
  }
});



test("watchdog skips zero amount budgets", async () => {
  const { calls, service } = createService([
    [
      {
        id: 123,
        user_id: 1,
        transaction_type: "expense",
        category: "Living",
        status: "confirmed",
        transaction_date: "2026-06-25",
      },
    ],
    [{ cycle_start_day: 25 }],
    [
      {
        budget_id: "12",
        category: "Living",
        parent_budget_id: null,
        budget_amount: "0",
        spent_amount: "500000",
      },
    ],
  ]);

  const result = await service.evaluateTransaction({
    userId: 1,
    transactionId: 123,
  });

  assert.equal(calls.length, 3);
  assert.equal(result.hasAlert, false);
  assert.deepEqual(result.alerts, []);
  assert.equal(result.message, null);
});

function pocketWatchdogRows(input: {
  category: string;
  child?: boolean;
  parentAlertExists?: boolean;
  parentInsertWins?: boolean;
}) {
  const childBreakdown = input.child
    ? [
        {
          budget_id: "84",
          category: "Dining",
          budget_amount: "1000000",
          spent_amount: "750000",
        },
      ]
    : [];
  const rows: unknown[][] = [
    [
      {
        id: 123,
        user_id: 1,
        transaction_type: "expense",
        category: input.category,
        status: "confirmed",
        transaction_date: "2026-08-30T12:00:00.000Z",
        pocket_id: "42",
      },
    ],
    [{ cycle_start_day: 1 }],
    [
      {
        budget_id: "42",
        category: "Monthly Transactions",
        parent_budget_id: null,
        budget_amount: "1000000",
        spent_amount: "750000",
        category_breakdown: childBreakdown,
      },
    ],
    [{ exists: input.parentAlertExists ?? false }],
  ];

  if (!input.parentAlertExists) {
    rows.push(
      input.parentInsertWins === false
        ? []
        : [
            {
              budget_id: "42",
              alert_type: "budget_75",
              threshold_percent: 75,
              period_key: "2026-08-01",
            },
          ],
    );
  }
  if (input.child) {
    rows.push([{ exists: false }]);
    rows.push([
      {
        budget_id: "84",
        alert_type: "budget_75",
        threshold_percent: 75,
        period_key: "2026-08-01",
      },
    ]);
  }

  return rows;
}

test("watchdog evaluates Toys against its assigned parent pocket only", async (t) => {
  t.mock.timers.enable({
    apis: ["Date"],
    now: new Date("2026-08-30T12:00:00.000Z"),
  });
  const { service } = createService(pocketWatchdogRows({ category: "Toys" }));

  const result = await service.evaluateTransaction({
    userId: 1,
    transactionId: 123,
  });

  assert.deepEqual(
    result.alerts.map(({ budgetId }) => budgetId),
    ["42"],
  );
});

test("watchdog evaluates Dining only against its pocket", async (t) => {
  t.mock.timers.enable({
    apis: ["Date"],
    now: new Date("2026-08-30T12:00:00.000Z"),
  });
  const { service } = createService(
    pocketWatchdogRows({ category: "Dining", child: true }),
  );

  const result = await service.evaluateTransaction({
    userId: 1,
    transactionId: 123,
  });

  assert.deepEqual(
    result.alerts.map(({ budgetId }) => budgetId),
    ["42"],
  );
});





test("watchdog evaluates Uncategorized against its assigned parent only", async (t) => {
  t.mock.timers.enable({
    apis: ["Date"],
    now: new Date("2026-08-30T12:00:00.000Z"),
  });
  const { service } = createService(
    pocketWatchdogRows({ category: "Uncategorized" }),
  );

  const result = await service.evaluateTransaction({
    userId: 1,
    transactionId: 123,
  });

  assert.deepEqual(
    result.alerts.map(({ budgetId }) => budgetId),
    ["42"],
  );
});

test("watchdog reclassification never emits a child alert", async (t) => {
  t.mock.timers.enable({
    apis: ["Date"],
    now: new Date("2026-08-30T12:00:00.000Z"),
  });
  const { service } = createService(
    pocketWatchdogRows({
      category: "Dining",
      child: true,
      parentAlertExists: true,
    }),
  );

  const result = await service.evaluateTransaction({
    userId: 1,
    transactionId: 123,
  });

  assert.deepEqual(
    result.alerts.map(({ budgetId }) => budgetId),
    [],
  );
});



test("overspending handle skips pending transaction alerts", async () => {
  const { service } = createService([
    [
      {
        id: 123,
        user_id: 1,
        transaction_type: "expense",
        category: "Food",
        status: "pending",
        transaction_date: "2026-06-25",
      },
    ],
  ]);

  const result = await service.handleOverspending({
    userId: 1,
    transactionId: 123,
  });

  assert.deepEqual(result, {
    ok: true,
    status: "no_alert",
    shouldAlert: false,
    alreadyAlerted: false,
    message: null,
    data: {
      transactionId: 123,
      userId: "1",
      category: "",
    },
  });
});

test("records overspending alert after delivery succeeds", async () => {
  const { calls, service } = createService([
    [{ exists: false }],
    [
      {
        budget_id: 12,
        alert_type: "overspend_80",
        threshold_percent: 80,
        period_key: "2026-06-25",
      },
    ],
  ]);

  const result = await service.recordOverspendingAlert({
    userId: 1,
    budgetId: 12,
    alertType: "overspend_80",
    periodKey: "2026-06-25",
  });

  assert.equal(calls.length, 2);
  assert.match(calls[1].text, /INSERT INTO budget_alerts/);
  assert.doesNotMatch(
    calls[1].text,
    /INSERT INTO budget_alerts\s*\(\s*user_id/,
  );
  assert.deepEqual(calls[1].values, [
    "1",
    "12",
    "overspend_80",
    80,
    "2026-06-25",
  ]);
  assert.deepEqual(result, {
    ok: true,
    status: "recorded",
    data: {
      userId: "1",
      budgetId: "12",
      alertType: "overspend_80",
      thresholdPercent: 80,
      periodKey: "2026-06-25",
    },
  });
});

test("record overspending alert is idempotent when alert already exists", async () => {
  const { calls, service } = createService([[{ exists: true }]]);

  const result = await service.recordOverspendingAlert({
    userId: 1,
    budgetId: 12,
    alertType: "overspend_120",
    thresholdPercent: 120,
    periodKey: "2026-06-25",
  });

  assert.equal(calls.length, 1);
  assert.deepEqual(result, {
    ok: true,
    status: "already_recorded",
    data: {
      userId: "1",
      budgetId: "12",
      alertType: "overspend_120",
      thresholdPercent: 120,
      periodKey: "2026-06-25",
    },
  });
});

test("record overspending alert validates alert type and period key", async () => {
  const { service } = createService();

  await assert.rejects(
    () =>
      service.recordOverspendingAlert({
        userId: 1,
        budgetId: 12,
        alertType: "other" as never,
        periodKey: "2026-06-25",
      }),
    BadRequestException,
  );

  await assert.rejects(
    () =>
      service.recordOverspendingAlert({
        userId: 1,
        budgetId: 12,
        alertType: "overspend_80",
        periodKey: "2026-6-25",
      }),
    BadRequestException,
  );
});
