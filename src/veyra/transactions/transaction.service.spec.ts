import * as assert from "node:assert/strict";
import { test } from "node:test";
import { BadRequestException } from "@nestjs/common";
import { DatabaseService } from "../../database/database.service";
import { BudgetService } from "../budgets/budget.service";
import {
  EmailParserTemplateProposalDto,
  EmailReviewTransactionCandidateDto,
  EmailTransactionHandleRequestDto,
  EmailTransactionMessageDto,
  EmailTransactionResolveReviewRequestDto,
  LearnedEmailTemplate,
} from "./dto/email-transaction.dto";
import { TransactionWatchdogResponseDto } from "./dto/transaction-watchdog.dto";
import { normalizeEmailWhitespace } from "./email-parsers";
import {
  ActivateEmailParserTemplateInput,
  EmailParserTemplateRepository,
} from "./email-parser-template.repository";
import { validateEmailTemplateProposal } from "./learned-email-parser";
import { TransactionRiskReviewRepository } from "./transaction-risk-review.repository";
import { TransactionService } from "./transaction.service";

function createService(
  rowsByCall: unknown[][] = [],
  budgetService?: BudgetService,
  riskReviewRepository?: TransactionRiskReviewRepository,
  emailParserTemplateRepository?: EmailParserTemplateRepository,
) {
  const calls: Array<{ text: string; values: unknown[] }> = [];
  const transactionEvents: Array<"begin" | "commit" | "rollback"> = [];
  const query = async (text: string, values: unknown[] = []) => {
    calls.push({ text, values });
    return { rows: rowsByCall.shift() ?? [] };
  };
  const database = {
    query,
    withTransaction: async (
      callback: (client: { query: typeof query }) => unknown,
    ) => {
      transactionEvents.push("begin");
      try {
        const result = await callback({ query });
        transactionEvents.push("commit");
        return result;
      } catch (error) {
        transactionEvents.push("rollback");
        throw error;
      }
    },
  } as unknown as DatabaseService;

  return {
    calls,
    transactionEvents,
    service: new TransactionService(
      database,
      budgetService,
      riskReviewRepository,
      emailParserTemplateRepository,
    ),
  };
}

function createTemplateRepository(
  templates: LearnedEmailTemplate[] = [],
  activateError?: Error,
) {
  const calls: Array<{ method: string; input: unknown }> = [];
  return {
    calls,
    repository: {
      findActive: async (userId: string, senderAddress: string) => {
        calls.push({ method: "findActive", input: { userId, senderAddress } });
        return templates;
      },
      activate: async (input: ActivateEmailParserTemplateInput) => {
        calls.push({ method: "activate", input });
        if (activateError) throw activateError;
        return { id: "7", ...input };
      },
      markMatched: async (templateId: string, userId: string) => {
        calls.push({ method: "markMatched", input: { templateId, userId } });
      },
      disable: async (templateId: string, userId: string) => {
        calls.push({ method: "disable", input: { templateId, userId } });
      },
    } as unknown as EmailParserTemplateRepository,
  };
}

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

function createManageStateStore(initialState?: {
  stateName: string;
  stateData: unknown;
  expiresAt?: string | null;
}) {
  const calls: Array<{ method: string; request: unknown }> = [];
  let state: {
    stateName: string;
    stateData: unknown;
    expiresAt: string | null;
  } = {
    stateName: initialState?.stateName ?? "idle",
    stateData: initialState?.stateData ?? {},
    expiresAt: initialState?.expiresAt ?? null,
  };

  return {
    calls,
    get state() {
      return state;
    },
    store: {
      getState: async (userId: string | number) => {
        calls.push({ method: "getState", request: userId });
        return state;
      },
      upsertState: async (request: {
        stateName: string;
        stateData?: unknown;
        expiresAt?: string | null;
      }) => {
        calls.push({ method: "upsertState", request });
        state = {
          stateName: request.stateName,
          stateData: request.stateData ?? {},
          expiresAt: request.expiresAt ?? null,
        };
        return {};
      },
      resetState: async (request: unknown) => {
        calls.push({ method: "resetState", request });
        state = { stateName: "idle", stateData: {}, expiresAt: null };
        return {};
      },
    },
  };
}

const pendingTransaction = {
  id: "pending-1",
  user_id: "user-1",
  transaction_type: "expense",
  amount: "50000",
  merchant: "gopay",
  merchant_normalized: "GoPay",
  category: "Transport",
  transaction_date: "2026-06-17T10:00:00.000Z",
  source: "email",
  bank: "BCA",
  payment_type: "QRIS",
  raw_payload: { emailId: "email-1" },
  resolved: false,
};

const transaction = {
  id: "tx-1",
  user_id: "user-1",
  amount: "50000",
  merchant: "gopay",
  merchant_normalized: "GoPay",
  category: "Transport",
  status: "pending",
};

const learnedProposal: EmailParserTemplateProposalDto = {
  provider: "Krom",
  templateKey: "learned-krom-qris",
  requiredAnchors: [
    "Pembayaran QR berhasil",
    "Merchant:",
    "Jumlah:",
    "Tanggal:",
  ],
  merchant: { kind: "text", after: "Merchant:", before: "Jumlah:" },
  amount: { kind: "idr_amount", after: "Jumlah:", before: "Tanggal:" },
  transactionDate: { kind: "datetime", after: "Tanggal:" },
  transactionType: "expense",
  paymentType: "QRIS",
};

const authenticatedUnknownKromEmail: EmailTransactionHandleRequestDto = {
  telegramUserId: "976684739",
  userId: "1",
  source: "email",
  email: {
    messageId: "gmail-learned-1",
    from: "alerts@krom.id",
    subject: "Pembayaran berhasil",
    date: "2026-07-27T09:30:00+07:00",
    emailText:
      "Pembayaran QR berhasil Merchant: Kopi Tuku Jumlah: Rp25.000 Tanggal: 27 Juli 2026 09:30",
    authentication: {
      dkim: "pass",
      spf: "pass",
      dmarc: "pass",
      domain: "krom.id",
    },
  },
};

const aiCandidate: EmailReviewTransactionCandidateDto = {
  source: "email",
  bank: "Krom",
  transactionType: "expense",
  amount: 25000,
  merchant: "Kopi Tuku",
  merchantNormalized: "Kopi Tuku",
  transactionDate: "2026-07-27T09:30:00+07:00",
  description: "Krom QR payment",
  rawPayload: {},
};

const correctedKromProposal: EmailParserTemplateProposalDto = {
  ...learnedProposal,
  amount: { kind: "idr_amount", after: "Jumlah:", before: "Tanggal:" },
};

const correctionEmail: EmailTransactionMessageDto = {
  ...authenticatedUnknownKromEmail.email,
  emailText:
    "Saldo: Rp25.000 Pembayaran QR berhasil Merchant: Kopi Tuku Jumlah: Rp30.000 Tanggal: 27 Juli 2026 09:30",
};

function validAiReviewRequest(
  overrides: Partial<EmailTransactionResolveReviewRequestDto> = {},
): EmailTransactionResolveReviewRequestDto {
  return {
    telegramUserId: "976684739",
    reviewToken: "gmail-learned-1",
    email: authenticatedUnknownKromEmail.email,
    transactionCandidate: aiCandidate,
    resolution: { category: "Food", confidence: 98, resolver: "llm" },
    templateProposal: learnedProposal,
    ...overrides,
  };
}

const invalidCorrection = validAiReviewRequest({
  transactionId: "123",
  transactionCandidate: { ...aiCandidate, amount: 0 },
});

async function resolveValidAiReview() {
  const { service } = createService([
    [{ id: "1", telegram_id: "976684739" }],
    [{ category: "Food" }],
    [{ id: "import-1", transaction_id: null, status: "needs_ai" }],
    [{ id: "123" }],
    [{ id: "import-1" }],
  ]);
  return service.resolveEmailTransactionReview(validAiReviewRequest());
}

function validatedFingerprint(
  email: EmailTransactionMessageDto,
  proposal: EmailParserTemplateProposalDto,
): string {
  const normalizedText = normalizeEmailWhitespace(email.emailText);
  const result = validateEmailTemplateProposal(
    {
      email,
      text: email.emailText,
      normalizedText,
      bodySource: "text",
      bodyWarnings: [],
    },
    proposal,
  );
  if (!result.ok) throw new Error(result.reason);
  assert.equal(result.ok, true);
  return result.fingerprint;
}

const learnedTemplate: LearnedEmailTemplate = {
  id: "7",
  userId: "1",
  senderAddress: "alerts@krom.id",
  fingerprint: validatedFingerprint(
    authenticatedUnknownKromEmail.email,
    learnedProposal,
  ),
  proposal: learnedProposal,
};

const pendingAiTransaction = {
  id: "123",
  user_id: "1",
  transaction_type: "expense",
  amount: "25000",
  merchant: "Kopi Tuku",
  merchant_normalized: "Kopi Tuku",
  category: "Food",
  transaction_date: "2026-07-27T09:30:00+07:00",
  source: "email",
  status: "pending",
  raw_payload: {
    email: {
      messageId: "gmail-learned-1",
      from: "alerts@krom.id",
    },
    parserSource: "ai",
    validatedTemplate: {
      fingerprint: learnedTemplate.fingerprint,
      proposal: learnedProposal,
    },
  },
};

const originalAiEmail: EmailTransactionHandleRequestDto = {
  ...authenticatedUnknownKromEmail,
  email: {
    ...authenticatedUnknownKromEmail.email,
    messageId: "gmail-learned-1",
  },
};

const learnedParsedTransaction = {
  ...pendingAiTransaction,
  raw_payload: {
    email: { messageId: "gmail-learned-2", from: "alerts@krom.id" },
    parserSource: "learned",
    templateId: "7",
  },
};

const authenticatedUnknownBankTransaction: EmailTransactionHandleRequestDto = {
  ...authenticatedUnknownKromEmail,
  email: {
    ...authenticatedUnknownKromEmail.email,
    messageId: "gmail-unknown-1",
    from: "alerts@newbank.id",
    subject: "Pembayaran berhasil",
    emailText: "Pembayaran berhasil sebesar Rp25.000",
    authentication: {
      dkim: "pass",
      spf: "pass",
      dmarc: "pass",
      domain: "newbank.id",
    },
  },
};

const unauthenticatedMatchingEmail: EmailTransactionHandleRequestDto = {
  ...authenticatedUnknownKromEmail,
  email: {
    ...authenticatedUnknownKromEmail.email,
    authentication: {
      dkim: "fail",
      spf: "unknown",
      dmarc: "fail",
      domain: "krom.id",
    },
  },
};

const riskReview = {
  id: "7",
  userId: "1",
  transactionId: "123",
  riskType: "large_transaction",
  riskLevel: "high" as const,
  riskScore: 82.5,
  riskReasons: [{ code: "high_budget_share", score: 40 }],
  riskMetrics: {
    transactionAmount: 850000,
    merchant: "Uniqlo",
    transactionBudgetSharePercent: 38,
    evaluationFingerprint: "fp-1",
  },
  status: "pending" as "pending" | "resolved" | "cancelled",
  userResponse: null as string | null,
  note: null,
  createdAt: "2026-07-06T00:00:00.000Z",
  updatedAt: "2026-07-06T00:00:00.000Z",
  resolvedAt: null,
};

function createRiskReviewRepository(review = riskReview) {
  const calls: Array<{ method: string; args: unknown[] }> = [];

  return {
    calls,
    repository: {
      createPendingReview: async (...args: unknown[]) => {
        calls.push({ method: "createPendingReview", args });
        return review;
      },
      saveLargeTransactionEvaluation: async (...args: unknown[]) => {
        calls.push({ method: "saveLargeTransactionEvaluation", args });
        return { review, shouldNotify: true };
      },
      cancelPendingLargeTransactionReview: async (...args: unknown[]) => {
        calls.push({ method: "cancelPendingLargeTransactionReview", args });
      },
      findById: async (...args: unknown[]) => {
        calls.push({ method: "findById", args });
        return review;
      },
      resolve: async (...args: unknown[]) => {
        calls.push({ method: "resolve", args });
        return { ...review, status: args[3], userResponse: args[2] };
      },
    } as unknown as TransactionRiskReviewRepository,
  };
}

const manageTransaction = {
  id: "101",
  user_id: "1",
  transaction_type: "expense",
  amount: "25000",
  merchant: "Kopi Tuku",
  merchant_normalized: "Kopi Tuku",
  category: "Others",
  transaction_date: "2026-06-25T03:00:00.000Z",
  notes: null,
  status: "confirmed",
  created_at: "2026-06-25T03:01:00.000Z",
};

const manageTransaction2 = {
  ...manageTransaction,
  id: "102",
  amount: "27000",
  transaction_date: "2026-06-24T03:00:00.000Z",
};

const budgetCategoryRows = [
  { id: "budget-food", category: "Food", parent_category: null },
  { id: "budget-transport", category: "Transport", parent_category: null },
  { id: "budget-groceries", category: "Groceries", parent_category: null },
  { id: "budget-bills", category: "Bills", parent_category: null },
  { id: "budget-health", category: "Health & Beauty", parent_category: null },
  { id: "budget-shopping", category: "Shopping", parent_category: null },
  {
    id: "budget-entertainment",
    category: "Entertainment",
    parent_category: null,
  },
  { id: "budget-transfer", category: "Transfer", parent_category: null },
  { id: "budget-other", category: "Other", parent_category: null },
];

test("normalizes a basic expense transaction", async () => {
  const { service } = createService([[], []]);

  const result = await service.normalizeTransaction({
    userId: "user-1",
    transactionType: "expense",
    amount: "Rp50.000",
    merchant: " gopay ",
    transactionDate: "2026-06-17T10:00:00.000Z",
  });

  assert.equal(result.userId, "user-1");
  assert.equal(result.transactionType, "expense");
  assert.equal(result.amount, 50000);
  assert.equal(result.merchant, "gopay");
  assert.equal(result.merchantNormalized, "gopay");
  assert.equal(result.category, null);
  assert.equal(result.source, "manual");
  assert.equal(result.notes, null);
  assert.deepEqual(result.warnings, []);
});

test("normalizes uppercase transaction type", async () => {
  const { service } = createService([[], []]);

  const result = await service.normalizeTransaction({
    userId: "user-1",
    transactionType: " INCOME ",
    amount: 75000,
    merchant: "Payroll",
  });

  assert.equal(result.transactionType, "income");
});

test("normalizes income without merchant or category", async () => {
  const { calls, service } = createService();

  const result = await service.normalizeTransaction({
    userId: "user-1",
    transactionType: "income",
    amount: 19_828_000,
    merchant: "",
  });

  assert.equal(result.merchant, null);
  assert.equal(result.merchantNormalized, null);
  assert.equal(result.category, null);
  assert.equal(calls.length, 0);
});

test("maps refund cashback and reversal cases safely", async () => {
  const { service } = createService([[], [], [], []]);

  const cashback = await service.normalizeTransaction({
    userId: "user-1",
    transactionType: "cashback",
    amount: 10000,
    merchant: "Bank Promo",
  });
  const reversal = await service.normalizeTransaction({
    userId: "user-1",
    transactionType: "expense",
    amount: 50000,
    merchant: "Card",
    rawPayload: { description: "void reversal" },
  });

  assert.equal(cashback.transactionType, "income");
  assert.deepEqual(cashback.warnings, [
    "refund/cashback input mapped to income",
  ]);
  assert.equal(reversal.transactionType, "reversal");
  assert.deepEqual(reversal.warnings, [
    "transactionType mapped to reversal from reversal-like input",
  ]);
});

test("uses merchant alias lookup when available", async () => {
  const { calls, service } = createService([[{ canonical_name: "GoPay" }], []]);

  const result = await service.normalizeTransaction({
    userId: "user-1",
    transactionType: "expense",
    amount: 50000,
    merchant: "gopay",
  });

  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].values, ["gopay"]);
  assert.match(calls[0].text, /canonical_name/);
  assert.match(calls[0].text, /alias_name/);
  assert.match(calls[0].text, /LIKE/);
  assert.doesNotMatch(calls[0].text, /user_id/);
  assert.equal(result.merchantNormalized, "GoPay");
  assert.equal(result.confidence, 85);
});

test("keeps original merchant when alias lookup misses", async () => {
  const { calls, service } = createService([[], []]);

  const result = await service.normalizeTransaction({
    userId: "user-1",
    transactionType: "expense",
    amount: "IDR 50,000.00",
    merchant: "Coffee Shop",
  });

  assert.equal(calls.length, 2);
  assert.equal(result.amount, 50000);
  assert.equal(result.merchantNormalized, "Coffee Shop");
  assert.equal(result.category, null);
  assert.equal(result.confidence, 70);
});

test("uses category rule lookup when available", async () => {
  const { calls, service } = createService([
    [{ canonical_name: "GoPay" }],
    [{ category: "Transport" }],
  ]);

  const result = await service.normalizeTransaction({
    userId: "user-1",
    transactionType: "expense",
    amount: 50000,
    merchant: "gopay",
  });

  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].values, ["GoPay", "gopay"]);
  assert.match(calls[1].text, /merchant_pattern/);
  assert.doesNotMatch(calls[1].text, /merchant_normalized/);
  assert.doesNotMatch(calls[1].text, /user_id/);
  assert.match(calls[1].text, /priority DESC NULLS LAST/);
  assert.equal(result.category, "Transport");
  assert.equal(result.confidence, 95);
});

test("rejects invalid amount", async () => {
  const { service } = createService();

  await assert.rejects(
    () =>
      service.normalizeTransaction({
        userId: "user-1",
        transactionType: "expense",
        amount: 0,
        merchant: "gopay",
      }),
    BadRequestException,
  );
});

test("rejects missing merchant for expense", async () => {
  const { service } = createService();

  await assert.rejects(
    () =>
      service.normalizeTransaction({
        userId: "user-1",
        transactionType: "expense",
        amount: 50000,
        merchant: " ",
      }),
    BadRequestException,
  );
});

test("defaults optional fields", async () => {
  const { service } = createService([[], []]);

  const before = Date.now();
  const result = await service.normalizeTransaction({
    userId: "user-1",
    transactionType: "expense",
    amount: 50000,
    merchant: "gopay",
  });
  const after = Date.now();
  const transactionTime = Date.parse(result.transactionDate);

  assert.equal(result.source, "manual");
  assert.equal(result.notes, null);
  assert.equal(result.category, null);
  assert.ok(transactionTime >= before);
  assert.ok(transactionTime <= after);
});

test("handles manual transaction with decimal confidence as confirmed", async () => {
  const { calls, service } = createService([[], [{ id: "tx-123" }]]);

  const result = await service.handleManualTransaction({
    telegramUserId: "976684739",
    userId: 1,
    source: "manual",
    text: "Spend 25k for kopi tuku",
    llmResult: {
      transaction_type: "expense",
      amount: 25000,
      merchant: "kopi tuku",
      category: "Coffee",
      confidence: 0.94,
      transaction_date: null,
      notes: null,
      missing_fields: [],
    },
  });

  assert.equal(result.status, "confirmed");
  assert.equal(result.transactionId, "tx-123");
  assert.match(
    result.message,
    /Recorded: Rp25\.000 at Kopi Tuku under Coffee\./,
  );
  assert.match(calls[1].text, /INSERT INTO transactions/);
  assert.deepEqual(calls[1].values.slice(0, 11), [
    "1",
    "expense",
    25000,
    "kopi tuku",
    "kopi tuku",
    "Coffee",
    calls[1].values[6],
    null,
    "confirmed",
    94,
    {
      text: "Spend 25k for kopi tuku",
      source: "manual",
      telegramUserId: "976684739",
      llmResult: {
        transaction_type: "expense",
        amount: 25000,
        merchant: "kopi tuku",
        category: "Coffee",
        confidence: 0.94,
        transaction_date: null,
        notes: null,
        missing_fields: [],
      },
    },
  ]);
});

test("records confirmed income without merchant or category", async () => {
  const { calls, service } = createService([[{ id: "income-1" }], []]);

  const result = await service.handleManualTransaction({
    userId: 1,
    source: "manual",
    text: "I got my salary income with amount of 19828k",
    llmResult: {
      transaction_type: "income",
      amount: 19_828_000,
      confidence: 95,
    },
  });

  assert.equal(result.status, "confirmed");
  assert.equal(result.message, "✅ Recorded income: Rp19.828.000.");
  assert.match(calls[0].text, /INSERT INTO transactions/);
  assert.deepEqual(calls[0].values.slice(0, 6), [
    "1",
    "income",
    19_828_000,
    null,
    null,
    null,
  ]);
});

test("records income with an optional merchant and no category", async () => {
  const { calls, service } = createService([
    [],
    [],
    [{ id: "income-office" }],
    [],
  ]);

  const result = await service.handleManualTransaction({
    userId: 1,
    source: "manual",
    llmResult: {
      transaction_type: "income",
      amount: 19_828_000,
      merchant: "Office",
      confidence: 95,
    },
  });

  assert.equal(result.status, "confirmed");
  assert.equal(result.message, "✅ Recorded income: Rp19.828.000 from Office.");
  assert.equal(calls[2].values[5], null);
});

test("builds pending income confirmation without merchant or category", async () => {
  const { service } = createService([[{ id: "income-pending" }], []]);

  const result = await service.handleManualTransaction({
    userId: 1,
    source: "manual",
    llmResult: {
      transaction_type: "income",
      amount: 19_828_000,
      confidence: 80,
    },
  });

  assert.equal(result.status, "pending");
  assert.match(result.confirmationPayload?.text ?? "", /Type: Income/);
  assert.match(result.confirmationPayload?.text ?? "", /Amount: Rp19\.828\.000/);
  assert.doesNotMatch(result.confirmationPayload?.text ?? "", /Merchant:/);
  assert.doesNotMatch(result.confirmationPayload?.text ?? "", /Category:/);
});

test("ignores merchant and category missing fields for income", async () => {
  const { calls, service } = createService([[{ id: "income-2" }], []]);

  const result = await service.handleManualTransaction({
    userId: 1,
    source: "manual",
    llmResult: {
      transaction_type: "income",
      amount: 19_828_000,
      confidence: 95,
      missing_fields: ["merchant", "category"],
    },
  });

  assert.equal(result.status, "confirmed");
  assert.match(calls[0].text, /INSERT INTO transactions/);
});

test("confirmed manual transaction resets state after insert", async () => {
  const { calls, service } = createService([[], [{ id: "tx-confirmed" }]]);
  const state = createStateStore();

  const result = await service.handleManualTransaction(
    {
      userId: 1,
      source: "manual",
      llmResult: {
        transaction_type: "expense",
        amount: 25000,
        merchant: "kopi tuku",
        category: "Coffee",
        confidence: 95,
      },
    },
    state.store,
  );

  assert.equal(result.status, "confirmed");
  assert.match(calls[1].text, /INSERT INTO transactions/);
  assert.deepEqual(state.calls, [
    { method: "resetState", request: { userId: 1 } },
  ]);
});

test("handles manual transaction with integer confidence as confirmed", async () => {
  const { calls, service } = createService([[], [{ id: "tx-94" }]]);

  const result = await service.handleManualTransaction({
    userId: 1,
    source: "manual",
    llmResult: {
      transaction_type: "expense",
      amount: 25000,
      merchant: "kopi tuku",
      category: "Coffee",
      confidence: 94,
    },
  });

  assert.equal(result.status, "confirmed");
  assert.equal(calls[1].values[9], 94);
  assert.equal(calls[1].values[8], "confirmed");
});

test("handles manual transaction with low confidence as pending confirmation", async () => {
  const { calls, service } = createService([[], [{ id: "tx-pending" }]]);

  const result = await service.handleManualTransaction({
    userId: 1,
    source: "manual",
    llmResult: {
      transaction_type: "expense",
      amount: 25000,
      merchant: "kopi tuku",
      category: "Coffee",
      confidence: 0.75,
    },
  });

  assert.equal(result.status, "pending");
  assert.equal(calls[1].values[8], "pending");
  assert.equal(calls[1].values[9], 75);
  assert.equal(result.message, "Please confirm this transaction.");
  assert.match(result.confirmationPayload?.text ?? "", /Confirm transaction/);
  assert.deepEqual(result.confirmationPayload?.reply_markup.inline_keyboard, [
    [
      { text: "Save", callback_data: "save_transaction:tx-pending" },
      {
        text: "Change Category",
        callback_data: "change_categories:tx-pending",
      },
    ],
    [{ text: "Cancel", callback_data: "cancel_transaction:tx-pending" }],
  ]);
});

test("pending manual transaction resets state after insert", async () => {
  const { calls, service } = createService([[], [{ id: "tx-pending" }]]);
  const state = createStateStore();

  const result = await service.handleManualTransaction(
    {
      userId: 1,
      source: "manual",
      llmResult: {
        transaction_type: "expense",
        amount: 25000,
        merchant: "kopi tuku",
        category: "Coffee",
        confidence: 75,
      },
    },
    state.store,
  );

  assert.equal(result.status, "pending");
  assert.match(calls[1].text, /INSERT INTO transactions/);
  assert.deepEqual(state.calls, [
    { method: "resetState", request: { userId: 1 } },
  ]);
});

test("cancel text resets state without inserting transaction", async () => {
  const { calls, service } = createService();
  const state = createStateStore();

  const result = await service.handleManualTransaction(
    {
      userId: 1,
      source: "manual",
      text: "batal",
      llmResult: {
        transaction_type: "expense",
        amount: 25000,
        merchant: "kopi tuku",
        category: "Coffee",
        confidence: 95,
      },
    },
    state.store,
  );

  assert.deepEqual(result, {
    status: "cancelled",
    transactionId: null,
    message: "Transaction recording cancelled.",
  });
  assert.equal(calls.length, 0);
  assert.deepEqual(state.calls, [
    { method: "resetState", request: { userId: 1 } },
  ]);
});

test("failed manual transaction insert does not reset state", async () => {
  const { service } = createService([[], []]);
  const state = createStateStore();

  await assert.rejects(
    () =>
      service.handleManualTransaction(
        {
          userId: 1,
          source: "manual",
          llmResult: {
            transaction_type: "expense",
            amount: 25000,
            merchant: "kopi tuku",
            category: "Coffee",
            confidence: 95,
          },
        },
        state.store,
      ),
    BadRequestException,
  );
  assert.deepEqual(state.calls, []);
});

test("accepts llm-provided category even when it is not in budgets", async () => {
  const { calls, service } = createService([[], [{ id: "tx-new-category" }]]);

  const result = await service.handleManualTransaction({
    userId: 1,
    source: "manual",
    llmResult: {
      transaction_type: "expense",
      amount: 25000,
      merchant: "kopi tuku",
      category: "Specialty Coffee",
      confidence: 95,
    },
  });

  assert.equal(result.status, "confirmed");
  assert.equal(calls.length, 3);
  assert.equal(calls[1].values[5], "Specialty Coffee");
});

test("rejects missing category when no category rule resolves it", async () => {
  const { calls, service } = createService([[], []]);

  await assert.rejects(
    () =>
      service.handleManualTransaction({
        userId: 1,
        source: "manual",
        llmResult: {
          transaction_type: "expense",
          amount: 25000,
          merchant: "kopi tuku",
          confidence: 95,
        },
      }),
    BadRequestException,
  );
  assert.equal(calls.length, 2);
});

test("resolves missing category from category rule before saving", async () => {
  const { calls, service } = createService([
    [],
    [{ category: "Coffee" }],
    [{ id: "tx-rule" }],
  ]);

  const result = await service.handleManualTransaction({
    userId: 1,
    source: "manual",
    llmResult: {
      transaction_type: "expense",
      amount: 25000,
      merchant: "kopi tuku",
      confidence: 95,
    },
  });

  assert.equal(result.status, "confirmed");
  assert.equal(calls[2].values[5], "Coffee");
  assert.match(calls[1].text, /FROM category_rules/);
});

test("returns unsupported source response without saving", async () => {
  const { calls, service } = createService();

  const result = await service.handleManualTransaction({
    userId: 1,
    source: "email",
    llmResult: {
      transaction_type: "expense",
      amount: 25000,
      merchant: "kopi tuku",
      category: "Coffee",
      confidence: 95,
    },
  });

  assert.deepEqual(result, {
    status: "unsupported_source",
    transactionId: null,
    message: "Transaction source email is not supported yet.",
  });
  assert.equal(calls.length, 0);
});

test("rejects missing llmResult without saving", async () => {
  const { calls, service } = createService();

  await assert.rejects(
    () =>
      service.handleManualTransaction({
        userId: 1,
        source: "manual",
      }),
    BadRequestException,
  );
  assert.equal(calls.length, 0);
});

test("manual transaction missing field saves pending state and asks follow-up", async () => {
  const { calls, service } = createService();
  const state = createStateStore();

  const result = await service.handleManualTransaction(
    {
      userId: 1,
      source: "manual",
      llmResult: {
        transaction_type: "expense",
        amount: 25000,
        merchant: "kopi tuku",
        confidence: 95,
        missing_fields: ["category"],
      },
    },
    state.store,
  );

  assert.deepEqual(result, {
    status: "awaiting_missing_field",
    transactionId: null,
    message: "Which category should I use?",
    state: {
      nextState: "record_transaction_state",
      payload: {
        transaction_type: "expense",
        amount: 25000,
        merchant: "kopi tuku",
        confidence: 95,
        missing_fields: ["category"],
        pending: true,
      },
    },
  });
  assert.deepEqual(state.calls, [
    {
      method: "upsertState",
      request: {
        userId: 1,
        stateName: "record_transaction_state",
        stateData: result.state?.payload,
      },
    },
  ]);
  assert.equal(calls.length, 0);
});

test("rejects missing required transaction fields without saving", async () => {
  const { calls, service } = createService();

  await assert.rejects(
    () =>
      service.handleManualTransaction({
        userId: 1,
        source: "manual",
        llmResult: {
          amount: 25000,
          merchant: "kopi tuku",
          category: "Coffee",
          confidence: 95,
        },
      }),
    BadRequestException,
  );
  assert.equal(calls.length, 0);
});

test("confirms a pending transaction created by manual handle", async () => {
  const { calls, service } = createService([
    [],
    [{ id: "tx-created" }],
    [
      {
        id: "tx-created",
        user_id: "1",
        transaction_type: "expense",
        amount: "25000",
        merchant: "kopi tuku",
        merchant_normalized: "kopi tuku",
        category: "Coffee",
        transaction_date: "2026-06-25",
        status: "pending",
      },
    ],
    [
      {
        id: "tx-created",
        user_id: "1",
        amount: "25000",
        merchant: "kopi tuku",
        merchant_normalized: "kopi tuku",
        category: "Coffee",
        status: "pending",
      },
    ],
    [],
  ]);

  const handleResult = await service.handleManualTransaction({
    userId: 1,
    source: "manual",
    llmResult: {
      transaction_type: "expense",
      amount: 25000,
      merchant: "kopi tuku",
      category: "Coffee",
      confidence: 75,
    },
  });
  const confirmResult = await service.confirmTransaction({
    transactionId: handleResult.transactionId ?? "",
    userId: "1",
  });

  assert.equal(handleResult.status, "pending");
  assert.equal(confirmResult.status, "confirmed");
  assert.deepEqual(calls[4].values, ["confirmed", "tx-created", "1"]);
  assert.match(calls[4].text, /UPDATE transactions/);
});

test("builds confirmation payload for normal pending transaction", () => {
  const { service } = createService();

  const result = service.buildConfirmationPayload({
    pendingTransactionId: "pending-1",
    transactionId: "tx-1",
    userId: "user-1",
    transactionType: "expense",
    amount: 50000,
    merchant: "gopay",
    merchantNormalized: "GoPay",
    category: "Transport",
    wallet: "BCA",
    notes: "QRIS payment",
    transactionDate: "2026-06-17T10:00:00.000Z",
    source: "email",
    confidence: 95,
    warnings: [],
  });

  assert.equal(
    result.text,
    "<b>Confirm transaction</b>\n\nType: Expense\nAmount: Rp50.000\nMerchant: GoPay\nCategory: Transport\nWallet: BCA\nNotes: QRIS payment",
  );
  assert.equal(result.parseMode, "HTML");
  assert.deepEqual(result.replyMarkup.inline_keyboard, [
    [
      { text: "Save", callback_data: "save_transaction:tx-1" },
      { text: "Change Category", callback_data: "change_categories:tx-1" },
    ],
    [{ text: "Cancel", callback_data: "cancel_transaction:tx-1" }],
  ]);
  assert.equal(
    result.replyMarkup.inline_keyboard
      .flat()
      .some((button) => button.callback_data.startsWith("tx_")),
    false,
  );
  assert.deepEqual(result.summary, {
    amount: 50000,
    merchant: "GoPay",
    category: "Transport",
    wallet: "BCA",
    notes: "QRIS payment",
  });
  assert.deepEqual(result.warnings, []);
});

test("builds readable confirmation payload without pendingTransactionId", () => {
  const { service } = createService();

  const result = service.buildConfirmationPayload({
    userId: "user-1",
    transactionType: "expense",
    amount: 50000,
    merchant: "gopay",
    category: "Transport",
    transactionDate: "2026-06-17T10:00:00.000Z",
    source: "manual",
  });

  assert.equal(
    result.text,
    "Confirm transaction\n\nType: Expense\nAmount: Rp50.000\nMerchant: gopay\nCategory: Transport\nWallet: -\nNotes: -\n\nWarnings:\n- callbacks require transactionId",
  );
  assert.equal(result.parseMode, null);
  assert.deepEqual(result.replyMarkup.inline_keyboard, []);
  assert.deepEqual(result.warnings, ["callbacks require transactionId"]);
});

test("builds experimental tx callbacks only in experimental mode", () => {
  const { service } = createService();

  const result = service.buildConfirmationPayload({
    pendingTransactionId: "pending-1",
    callbackMode: "experimental",
    format: "plain",
    userId: "user-1",
    transactionType: "expense",
    amount: 50000,
    merchant: "gopay",
    category: "Transport",
    transactionDate: "2026-06-17T10:00:00.000Z",
    source: "manual",
  });

  assert.deepEqual(result.replyMarkup.inline_keyboard, [
    [
      { text: "Approve", callback_data: "tx_confirm:pending-1" },
      { text: "Change Category", callback_data: "tx_category:pending-1" },
    ],
    [{ text: "Reject", callback_data: "tx_reject:pending-1" }],
  ]);
  assert.deepEqual(result.warnings, []);
});

test("includes low confidence transaction in confirmation text", () => {
  const { service } = createService();

  const result = service.buildConfirmationPayload({
    pendingTransactionId: "pending-1",
    transactionId: "tx-1",
    userId: "user-1",
    transactionType: "expense",
    amount: 50000,
    merchant: "gopay",
    category: "Transport",
    transactionDate: "2026-06-17T10:00:00.000Z",
    source: "manual",
    confidence: 45,
  });

  assert.equal(
    result.text,
    "Confirm transaction\n\nType: Expense\nAmount: Rp50.000\nMerchant: gopay\nCategory: Transport\nWallet: -\nNotes: -",
  );
});

test("builds income confirmation payload", () => {
  const { service } = createService();

  const result = service.buildConfirmationPayload({
    pendingTransactionId: "pending-income",
    userId: "user-1",
    transactionType: "income",
    amount: 2500000,
    merchant: "Payroll",
    category: "Salary",
    transactionDate: "2026-06-17T10:00:00.000Z",
    source: "manual",
  });

  assert.match(result.text, /Type: Income/);
  assert.match(result.text, /Amount: Rp2\.500\.000/);
  assert.equal(result.summary.category, "Salary");
  assert.equal(result.summary.wallet, "-");
  assert.equal(result.summary.notes, "-");
});

test("builds expense confirmation payload", () => {
  const { service } = createService();

  const result = service.buildConfirmationPayload({
    pendingTransactionId: "pending-expense",
    userId: "user-1",
    transactionType: "expense",
    amount: 125000,
    merchant: "Coffee Shop",
    category: "Food",
    transactionDate: "2026-06-17T10:00:00.000Z",
    source: "manual",
  });

  assert.match(result.text, /Type: Expense/);
  assert.match(result.text, /Category: Food/);
  assert.equal(result.summary.amount, 125000);
});

test("builds manual confirmation payload snapshot with wallet and notes", () => {
  const { service } = createService();

  const result = service.buildConfirmationPayload({
    transactionId: "tx-manual",
    userId: "user-1",
    transactionType: "expense",
    amount: 75000,
    merchant: "Coffee Shop",
    category: "Food",
    wallet: "Cash",
    notes: "Latte and breakfast",
    transactionDate: "2026-06-17T10:00:00.000Z",
    source: "manual",
  });

  assert.equal(
    result.text,
    "Confirm transaction\n\nType: Expense\nAmount: Rp75.000\nMerchant: Coffee Shop\nCategory: Food\nWallet: Cash\nNotes: Latte and breakfast",
  );
  assert.equal(result.parseMode, null);
  assert.deepEqual(result.replyMarkup.inline_keyboard, [
    [
      { text: "Save", callback_data: "save_transaction:tx-manual" },
      {
        text: "Change Category",
        callback_data: "change_categories:tx-manual",
      },
    ],
    [{ text: "Cancel", callback_data: "cancel_transaction:tx-manual" }],
  ]);
});

test("builds email confirmation payload snapshot with escaped HTML", () => {
  const { service } = createService();

  const result = service.buildConfirmationPayload({
    transactionId: "tx-email",
    userId: "user-1",
    transactionType: "expense",
    amount: 125000,
    merchant: "R&D <Cafe>",
    category: "Food",
    wallet: "BCA & QRIS",
    notes: "Lunch <team>",
    transactionDate: "2026-06-17T10:00:00.000Z",
    source: "email",
  });

  assert.equal(
    result.text,
    "<b>Confirm transaction</b>\n\nType: Expense\nAmount: Rp125.000\nMerchant: R&amp;D &lt;Cafe&gt;\nCategory: Food\nWallet: BCA &amp; QRIS\nNotes: Lunch &lt;team&gt;",
  );
  assert.equal(result.parseMode, "HTML");
});

test("displays normalization warnings in confirmation text", () => {
  const { service } = createService();

  const result = service.buildConfirmationPayload({
    pendingTransactionId: "pending-warning",
    transactionId: "tx-warning",
    userId: "user-1",
    transactionType: "income",
    amount: 10000,
    merchant: "Bank Promo",
    category: "Rewards",
    transactionDate: "2026-06-17T10:00:00.000Z",
    source: "manual",
    warnings: ["refund/cashback input mapped to income"],
  });

  assert.match(result.text, /Warnings:/);
  assert.match(result.text, /- refund\/cashback input mapped to income/);
  assert.deepEqual(result.warnings, ["refund/cashback input mapped to income"]);
});

test("confirms a pending transaction row", async () => {
  const { calls, service } = createService([
    [
      {
        id: "tx-1",
        user_id: "user-1",
        amount: "50000",
        merchant: "gopay",
        merchant_normalized: "GoPay",
        category: "Transport",
        status: "pending",
      },
    ],
    [],
  ]);

  const result = await service.confirmTransaction({
    transactionId: "tx-1",
    userId: "user-1",
  });

  assert.deepEqual(result, {
    status: "confirmed",
    transactionId: "tx-1",
    userId: "user-1",
    summary: {
      amount: 50000,
      merchant: "GoPay",
      category: "Transport",
    },
    editMessage: {
      text: "Transaction tx-1 confirmed: GoPay • Rp50.000",
      parseMode: null,
    },
    notifications: [],
  });
  assert.deepEqual(calls[0].values, ["tx-1", "user-1"]);
  assert.match(calls[0].text, /FROM transactions/);
  assert.match(calls[1].text, /UPDATE transactions/);
  assert.match(calls[1].text, /updated_at = now\(\)/);
  assert.deepEqual(calls[1].values, ["confirmed", "tx-1", "user-1"]);
});

test("confirmed transaction appends watchdog warning text", async () => {
  const watchdog = {
    checked: true,
    hasAlert: true,
    alerts: [
      {
        type: "budget_90" as const,
        budgetId: "12",
        category: "Transport",
        usedPercent: 91,
        remainingAmount: 90000,
        safeDailySpend: 12857,
        projectedCycleSpend: 1200000,
        projectedOverrun: 200000,
      },
    ],
    message: {
      text: "<b>Budget warning.</b>\nTransport is now 91% used.",
      parse_mode: "HTML" as const,
      disable_web_page_preview: true as const,
    },
  };
  const budgetService = {
    evaluateTransaction: async () => watchdog,
  } as unknown as BudgetService;
  const { service } = createService(
    [
      [
        {
          id: "tx-1",
          user_id: "user-1",
          transaction_type: "expense",
          transaction_date: "2026-06-25",
          amount: "50000",
          merchant: "gopay",
          merchant_normalized: "GoPay",
          category: "Transport",
          status: "pending",
        },
      ],
      [],
      [
        {
          id: "tx-1",
          user_id: "user-1",
          transaction_type: "expense",
          transaction_date: "2026-06-25",
          amount: "50000",
          merchant: "gopay",
          merchant_normalized: "GoPay",
          category: "Transport",
          status: "confirmed",
        },
      ],
    ],
    budgetService,
  );

  const result = await service.confirmTransaction({
    transactionId: "tx-1",
    userId: "user-1",
  });

  assert.equal(result.watchdog, watchdog);
  assert.deepEqual(result.notifications, [
    {
      type: "budget_alert",
      priority: 2,
      severity: "warning",
      message: "Transport budget reached 91%",
    },
  ]);
  assert.match(result.editMessage?.text ?? "", /Budget warning/);
  assert.equal(result.editMessage?.parseMode, "HTML");
});

test("cancels a pending transaction row", async () => {
  const { calls, service } = createService([
    [
      {
        id: "tx-1",
        user_id: "user-1",
        amount: "50000",
        merchant: "gopay",
        merchant_normalized: "GoPay",
        category: "Transport",
        status: "pending",
      },
    ],
    [],
  ]);

  const result = await service.cancelTransaction({
    transactionId: "tx-1",
    userId: "user-1",
  });

  assert.equal(result.status, "rejected");
  assert.deepEqual(result.summary, {
    amount: 50000,
    merchant: "GoPay",
    category: "Transport",
  });
  assert.deepEqual(result.editMessage, {
    text: "Transaction tx-1 cancelled.",
    parseMode: null,
  });
  assert.match(calls[1].text, /UPDATE transactions/);
  assert.deepEqual(calls[1].values, ["rejected", "tx-1", "user-1"]);
});

test("returns already_confirmed without updating transaction row", async () => {
  const { calls, service } = createService([
    [
      {
        id: "tx-1",
        user_id: "user-1",
        amount: "50000",
        merchant: "gopay",
        merchant_normalized: "GoPay",
        category: "Transport",
        status: "confirmed",
      },
    ],
  ]);

  const result = await service.confirmTransaction({
    transactionId: "tx-1",
    userId: "user-1",
  });

  assert.equal(result.status, "already_confirmed");
  assert.equal(calls.length, 1);
});

test("returns already_rejected without updating transaction row", async () => {
  const { calls, service } = createService([
    [
      {
        id: "tx-1",
        user_id: "user-1",
        amount: "50000",
        merchant: "gopay",
        merchant_normalized: "GoPay",
        category: "Transport",
        status: "rejected",
      },
    ],
  ]);

  const result = await service.cancelTransaction({
    transactionId: "tx-1",
    userId: "user-1",
  });

  assert.equal(result.status, "already_rejected");
  assert.equal(calls.length, 1);
});

test("returns not_found when transaction row does not exist", async () => {
  const { calls, service } = createService([[]]);

  const result = await service.confirmTransaction({
    transactionId: "missing",
    userId: "user-1",
  });

  assert.deepEqual(result, {
    status: "not_found",
    transactionId: "missing",
    userId: "user-1",
    summary: null,
    editMessage: null,
  });
  assert.equal(calls.length, 1);
});

test("returns not_found for transaction owned by a different user", async () => {
  const { calls, service } = createService([[]]);

  const result = await service.confirmTransaction({
    transactionId: "tx-1",
    userId: "user-2",
  });

  assert.deepEqual(result, {
    status: "not_found",
    transactionId: "tx-1",
    userId: "user-2",
    summary: null,
    editMessage: null,
  });
  assert.deepEqual(calls[0].values, ["tx-1", "user-2"]);
  assert.match(calls[0].text, /AND user_id::text = \$2/);
  assert.equal(calls.length, 1);
});

test("builds category options for pending transaction", async () => {
  const { service } = createService([
    [transaction],
    [pendingTransaction],
    budgetCategoryRows,
  ]);

  const result = await service.buildCategoryOptions({
    pendingTransactionId: "pending-1",
    transactionId: "tx-1",
    userId: "user-1",
  });

  assert.equal(result.status, "ok");
  assert.match(result.text ?? "", /Choose transaction category/);
  assert.match(result.text ?? "", /Merchant: GoPay/);
  assert.equal(result.replyMarkup?.inline_keyboard.length, 9);
});

test("returns not_found for missing category options pending transaction", async () => {
  const { service } = createService([[]]);

  const result = await service.buildCategoryOptions({
    pendingTransactionId: "missing",
    userId: "user-1",
  });

  assert.deepEqual(result, {
    status: "not_found",
    pendingTransactionId: "missing",
    text: null,
    replyMarkup: null,
  });
});

test("returns already_resolved for category options resolved transaction", async () => {
  const { service } = createService([
    [{ ...pendingTransaction, resolved: true }],
  ]);

  const result = await service.buildCategoryOptions({
    pendingTransactionId: "pending-1",
    userId: "user-1",
  });

  assert.deepEqual(result, {
    status: "already_resolved",
    pendingTransactionId: "pending-1",
    text: null,
    replyMarkup: null,
  });
});

test("rejects invalid category selection", async () => {
  const { service } = createService();

  await assert.rejects(
    () =>
      service.setPendingTransactionCategory({
        pendingTransactionId: "pending-1",
        userId: "user-1",
        category: "Travel",
      }),
    BadRequestException,
  );
});

test("sets pending transaction category and returns confirmation payload", async () => {
  const { calls, service } = createService([[pendingTransaction], []]);

  const result = await service.setPendingTransactionCategory({
    pendingTransactionId: "pending-1",
    userId: "user-1",
    category: "Food",
  });

  assert.equal(result.status, "updated");
  assert.equal(result.confirmationPayload?.summary.category, "Food");
  assert.match(result.confirmationPayload?.text ?? "", /Category: Food/);
  assert.deepEqual(calls[1].values, ["Food", "pending-1", "user-1"]);
  assert.match(calls[1].text, /UPDATE pending_transactions/);
  assert.match(calls[1].text, /category_suggested/);
});

test("formats production category callback data with budget and transaction ids", async () => {
  const { service } = createService([
    [transaction],
    [pendingTransaction],
    budgetCategoryRows,
  ]);

  const result = await service.buildCategoryOptions({
    pendingTransactionId: "pending-1",
    transactionId: "tx-1",
    userId: "user-1",
  });

  const buttons = result.replyMarkup?.inline_keyboard.flat() ?? [];

  assert.deepEqual(
    buttons.map((button) => button.callback_data),
    [
      "catid:budget-food:tx-1",
      "catid:budget-transport:tx-1",
      "catid:budget-groceries:tx-1",
      "catid:budget-bills:tx-1",
      "catid:budget-health:tx-1",
      "catid:budget-shopping:tx-1",
      "catid:budget-entertainment:tx-1",
      "catid:budget-transfer:tx-1",
      "catid:budget-other:tx-1",
    ],
  );
  assert.equal(
    buttons.some((button) => button.callback_data.startsWith("tx_")),
    false,
  );
});

test("builds production category options from custom leaf budgets", async () => {
  const { calls, service } = createService([
    [transaction],
    [pendingTransaction],
    [
      {
        id: "budget-dining",
        category: "Dining Out With A Very Long Name",
        parent_category: "Food",
      },
      { id: "budget-meds", category: "Medicine", parent_category: "Health" },
    ],
  ]);

  const result = await service.buildCategoryOptions({
    pendingTransactionId: "pending-1",
    transactionId: "tx-1",
    userId: "user-1",
  });

  const buttons = result.replyMarkup?.inline_keyboard.flat() ?? [];

  assert.deepEqual(
    buttons.map((button) => button.callback_data),
    ["catid:budget-dining:tx-1", "catid:budget-meds:tx-1"],
  );
  assert.equal(buttons[0].text.length, 32);
  assert.equal(buttons[0].text, "Food / Dining Out With A Very...");
  assert.equal(buttons[1].text, "Health / Medicine");
  assert.match(calls[2].text, /NOT EXISTS/);
  assert.match(calls[2].text, /active_child\.parent_budget_id = child\.id/);
});

test("falls back to production default categories when user has no active leaf budgets", async () => {
  const { service } = createService([[transaction], [pendingTransaction], []]);

  const result = await service.buildCategoryOptions({
    pendingTransactionId: "pending-1",
    transactionId: "tx-1",
    userId: "user-1",
  });

  const buttons = result.replyMarkup?.inline_keyboard.flat() ?? [];

  assert.deepEqual(
    buttons.map((button) => button.text),
    [
      "Food",
      "Transport",
      "Groceries",
      "Bills",
      "Health & Beauty",
      "Shopping",
      "Entertainment",
      "Transfer",
      "Other",
    ],
  );
});

test("rejects category selection with unauthorized budget id", async () => {
  const { service } = createService([[transaction], []]);

  const result = await service.setPendingTransactionCategory({
    transactionId: "tx-1",
    budgetId: "budget-other-user",
    userId: "user-1",
  });

  assert.equal(result.status, "unauthorized_budget");
  assert.equal(result.transactionId, "tx-1");
  assert.equal(result.editMessage, null);
});

test("sets transaction category and confirms on production category selection", async () => {
  const { calls, service } = createService([
    [transaction],
    [{ id: "budget-food", category: "Food", parent_category: null }],
    [],
  ]);

  const result = await service.setPendingTransactionCategory({
    transactionId: "tx-1",
    budgetId: "budget-food",
    userId: "user-1",
  });

  assert.equal(result.status, "updated");
  assert.equal(result.transactionId, "tx-1");
  assert.equal(result.summary?.category, "Food");
  assert.equal(
    result.editMessage?.text,
    "Transaction tx-1 confirmed: GoPay • Rp50.000",
  );
  assert.deepEqual(calls[2].values, ["Food", "tx-1", "user-1"]);
  assert.match(calls[2].text, /UPDATE transactions/);
  assert.match(calls[2].text, /status = 'confirmed'/);
});

test("handles save_transaction callback with Telegram edit payload", async () => {
  const { calls, service } = createService([
    [{ ...transaction, id: "123", user_id: "1" }],
    [],
  ]);

  const result = await service.handleTransactionCallback({
    telegramUserId: "976684739",
    userId: 1,
    callbackData: "save_transaction:123",
    chatId: "chat-1",
    messageId: 42,
  });

  assert.equal(result.status, "ok");
  assert.equal(result.action, "save_transaction");
  assert.equal(result.transactionId, 123);
  assert.deepEqual(result.telegram, {
    method: "editMessageText",
    chat_id: "chat-1",
    message_id: 42,
    text: "Transaction 123 confirmed: GoPay • Rp50.000",
    parse_mode: "HTML",
    reply_markup: null,
  });
  assert.deepEqual(calls[0].values, ["123", "1"]);
  assert.deepEqual(calls[1].values, ["confirmed", "123", "1"]);
});

test("handles cancel_transaction callback with Telegram edit payload", async () => {
  const { calls, service } = createService([
    [{ ...transaction, id: "123", user_id: "1" }],
    [],
  ]);

  const result = await service.handleTransactionCallback({
    telegramUserId: "976684739",
    userId: 1,
    callbackData: "cancel_transaction:123",
  });

  assert.equal(result.status, "ok");
  assert.equal(result.action, "cancel_transaction");
  assert.equal(result.transactionId, 123);
  assert.deepEqual(result.telegram, {
    method: "editMessageText",
    text: "Transaction 123 cancelled.",
    parse_mode: "HTML",
    reply_markup: null,
  });
  assert.deepEqual(calls[1].values, ["rejected", "123", "1"]);
});

test("handles change_categories callback with category buttons", async () => {
  const { service } = createService([
    [{ ...transaction, id: "123", user_id: "1" }],
    [
      { id: "10", category: "Food", parent_category: null },
      { id: "11", category: "Transport", parent_category: null },
    ],
  ]);

  const result = await service.handleTransactionCallback({
    telegramUserId: "976684739",
    userId: 1,
    callbackData: "change_categories:123",
  });

  assert.equal(result.status, "ok");
  assert.equal(result.action, "change_categories");
  assert.equal(result.transactionId, 123);
  assert.match(result.telegram.text, /Choose transaction category/);
  assert.deepEqual(result.telegram.reply_markup, {
    inline_keyboard: [
      [{ text: "Food", callback_data: "catid:10:123" }],
      [{ text: "Transport", callback_data: "catid:11:123" }],
    ],
  });
});

test("handles catid callback by setting category and confirming transaction", async () => {
  const { calls, service } = createService([
    [{ ...transaction, id: "123", user_id: "1" }],
    [{ id: "10", category: "Food", parent_category: null }],
    [],
  ]);

  const result = await service.handleTransactionCallback({
    telegramUserId: "976684739",
    userId: 1,
    callbackData: "catid:10:123",
  });

  assert.equal(result.status, "ok");
  assert.equal(result.action, "catid");
  assert.equal(result.transactionId, 123);
  assert.equal(result.telegram.text, "Transaction 123 confirmed: GoPay • Rp50.000");
  assert.equal(result.telegram.reply_markup, null);
  assert.deepEqual(calls[2].values, ["Food", "123", "1"]);
});

test("creates large transaction review with Telegram-safe keyboard", async () => {
  const riskReviews = createRiskReviewRepository();
  const { service } = createService([], undefined, riskReviews.repository);

  const result = await service.createRegretDetectorReview({
    userId: 1,
    transactionId: 123,
    riskLevel: "high",
    riskScore: 82.5,
    riskReasons: ["large_purchase"],
    riskMetrics: riskReview.riskMetrics,
  });

  assert.equal(result.status, "ok");
  assert.match(result.telegram.text, /<b>⚠️ Large transaction detected<\/b>/);
  assert.match(result.telegram.text, /Rp850\.000 at Uniqlo/);
  assert.match(result.telegram.text, /38% of your monthly budget/);
  assert.deepEqual(result.telegram.reply_markup, {
    inline_keyboard: [
      [
        { text: "Planned", callback_data: "veyra_risk:7:planned" },
        { text: "Necessary", callback_data: "veyra_risk:7:necessary" },
      ],
      [
        { text: "Regret it", callback_data: "veyra_risk:7:regret" },
        { text: "Ignore", callback_data: "veyra_risk:7:ignore" },
      ],
    ],
  });
});

test("handles risk planned callback by resolving review", async () => {
  const riskReviews = createRiskReviewRepository();
  const { service } = createService([], undefined, riskReviews.repository);

  const result = await service.handleTransactionCallback({
    telegramUserId: "976684739",
    userId: 1,
    callbackData: "veyra_risk:7:planned",
  });

  assert.equal(result.status, "ok");
  assert.equal(result.action, "veyra_risk");
  assert.equal(result.transactionId, 123);
  assert.equal(result.telegram.text, "Noted. This purchase was planned.");
  assert.deepEqual(riskReviews.calls[1], {
    method: "resolve",
    args: [7, 1, "planned", "resolved", undefined],
  });
});

test("handles risk necessary, regret, and ignore callbacks", async () => {
  const riskReviews = createRiskReviewRepository();
  const { service } = createService([], undefined, riskReviews.repository);
  const cases = [
    ["necessary", "Noted. This purchase was necessary."],
    ["regret", "Recorded as a regretted purchase."],
    ["ignore", "Ignored."],
  ] as const;

  for (const [response, text] of cases) {
    const result = await service.handleTransactionCallback({
      telegramUserId: "976684739",
      userId: 1,
      callbackData: `veyra_risk:7:${response}`,
    });

    assert.equal(result.status, "ok");
    assert.equal(result.action, "veyra_risk");
    assert.equal(result.telegram.text, text);
  }
});

test("duplicate risk callback is safe and does not overwrite response", async () => {
  const riskReviews = createRiskReviewRepository({
    ...riskReview,
    status: "resolved" as const,
    userResponse: "planned",
  });
  const { service } = createService([], undefined, riskReviews.repository);

  const result = await service.handleTransactionCallback({
    telegramUserId: "976684739",
    userId: 1,
    callbackData: "veyra_risk:7:regret",
  });

  assert.equal(result.status, "ok");
  assert.equal(result.telegram.text, "This transaction review was already answered.");
  assert.equal(
    riskReviews.calls.some((call) => call.method === "resolve"),
    false,
  );
});

test("regret note state updates transaction note and resolves review", async () => {
  const riskReviews = createRiskReviewRepository();
  const state = createManageStateStore({
    stateName: "veyra_regret_note",
    stateData: { review_id: "7", transaction_id: "123" },
  });
  const { calls, service } = createService(
    [[]],
    undefined,
    riskReviews.repository,
  );

  const result = await service.handleManualTransaction(
    {
      userId: 1,
      source: "manual",
      text: "Planned during payday sale",
    },
    state.store,
  );

  assert.equal(result.status, "regret_note_added");
  assert.equal(result.transactionId, "123");
  assert.equal(result.message, "Note added.");
  assert.match(calls[0].text, /UPDATE transactions/);
  assert.deepEqual(calls[0].values, ["Planned during payday sale", "123", "1"]);
  assert.deepEqual(riskReviews.calls[0], {
    method: "findById",
    args: ["7", 1],
  });
  assert.deepEqual(riskReviews.calls[1], {
    method: "resolve",
    args: ["7", 1, "regret", "resolved", "Planned during payday sale"],
  });
  assert.deepEqual(state.calls.at(-1), {
    method: "resetState",
    request: { userId: 1 },
  });
});

test("returns safe error payload for invalid transaction callback data", async () => {
  const { calls, service } = createService();

  const result = await service.handleTransactionCallback({
    telegramUserId: "976684739",
    userId: 1,
    callbackData: "save_transaction:not-a-number",
    chatId: 1001,
    messageId: 7,
  });

  assert.deepEqual(result, {
    status: "error",
    action: "save_transaction",
    transactionId: undefined,
    telegram: {
      method: "editMessageText",
      chat_id: 1001,
      message_id: 7,
      text: "Invalid transaction callback.",
      parse_mode: "HTML",
      reply_markup: null,
    },
  });
  assert.equal(calls.length, 0);
});

test("manage returns invalid when telegram user is not found", async () => {
  const { calls, service } = createService([[]]);
  const state = createManageStateStore();

  const result = await service.handleManagedTransaction(
    {
      telegramUserId: "976684739",
      text: "edit kopi tuku to Food",
      statePayload: {
        state_name: "confirm_action",
        state_data: { transaction_id: 101 },
      },
      llmResult: {
        intent: "edit_transaction",
        target: { merchant: "kopi tuku", period: "recent" },
        changes: { category: "Food" },
      },
    },
    state.store,
  );

  assert.equal(result.ok, false);
  assert.equal(result.status, "invalid");
  assert.equal(state.calls.length, 0);
  assert.equal(calls.length, 1);
});

test("manage callback cancel resets DB state", async () => {
  const { service } = createService([[{ id: "1", telegram_id: "976684739" }]]);
  const state = createManageStateStore({
    stateName: "select_transaction",
    stateData: { action: "delete", candidates: [manageTransaction] },
  });

  const result = await service.handleManagedTransaction(
    {
      telegramUserId: "976684739",
      text: "veyra_tx_manage:cancel",
      llmResult: null,
    },
    state.store,
  );

  assert.equal(result.status, "cancelled");
  assert.equal(result.reply_markup, null);
  assert.equal(state.state.stateName, "idle");
  assert.deepEqual(state.calls.at(-1), {
    method: "resetState",
    request: { userId: "1" },
  });
});

test("manage edit no match resets state and returns not_found", async () => {
  const { calls, service } = createService([
    [{ id: "1", telegram_id: "976684739" }],
    [],
  ]);
  const state = createManageStateStore();

  const result = await service.handleManagedTransaction(
    {
      telegramUserId: "976684739",
      text: "edit kopi tuku to Food",
      llmResult: {
        intent: "edit_transaction",
        target: { merchant: "kopi tuku" },
        changes: { category: "Food" },
      },
    },
    state.store,
  );

  assert.equal(result.status, "not_found");
  assert.equal(result.reply_markup, null);
  assert.match(calls[1].text, /FROM transactions/);
  assert.deepEqual(state.calls.at(-1), {
    method: "resetState",
    request: { userId: "1" },
  });
});

test("manage edit one match creates confirm_action with confirm keyboard", async () => {
  const { service } = createService([
    [{ id: "1", telegram_id: "976684739" }],
    [manageTransaction],
  ]);
  const state = createManageStateStore();

  const result = await service.handleManagedTransaction(
    {
      telegramUserId: "976684739",
      text: "edit kopi tuku to Food",
      llmResult: {
        intent: "edit_transaction",
        target: { merchant: "kopi tuku" },
        changes: { category: "Food" },
      },
    },
    state.store,
  );

  assert.equal(result.status, "needs_confirmation");
  assert.equal(state.state.stateName, "confirm_action");
  assert.equal((state.state.stateData as { action: string }).action, "edit");
  assert.deepEqual(result.reply_markup?.inline_keyboard, [
    [
      { text: "Confirm", callback_data: "veyra_tx_manage:confirm" },
      { text: "Cancel", callback_data: "veyra_tx_manage:cancel" },
    ],
  ]);
  assert.match(result.message, /Before:\nKopi Tuku — Others — Rp25\.000/);
  assert.match(result.message, /After:\nKopi Tuku — Food — Rp25\.000/);
});

test("manage edit multiple matches creates select_transaction with candidate keyboard", async () => {
  const { service } = createService([
    [{ id: "1", telegram_id: "976684739" }],
    [manageTransaction, manageTransaction2],
  ]);
  const state = createManageStateStore();

  const result = await service.handleManagedTransaction(
    {
      telegramUserId: "976684739",
      text: "edit kopi tuku to Food",
      llmResult: {
        intent: "edit_transaction",
        target: { merchant: "kopi tuku" },
        changes: { category: "Food" },
      },
    },
    state.store,
  );

  assert.equal(result.status, "needs_selection");
  assert.equal(state.state.stateName, "select_transaction");
  assert.equal(result.reply_markup?.inline_keyboard.length, 3);
  assert.deepEqual(result.reply_markup?.inline_keyboard[0], [
    {
      text: "1. Kopi Tuku — Rp25.000",
      callback_data: "veyra_tx_manage:select:1",
    },
  ]);
  assert.deepEqual(result.reply_markup?.inline_keyboard[2], [
    { text: "Cancel", callback_data: "veyra_tx_manage:cancel" },
  ]);
});

test("manage delete one match creates confirm_action with confirm keyboard", async () => {
  const { service } = createService([
    [{ id: "1", telegram_id: "976684739" }],
    [manageTransaction],
  ]);
  const state = createManageStateStore();

  const result = await service.handleManagedTransaction(
    {
      telegramUserId: "976684739",
      text: "delete kopi tuku",
      llmResult: {
        intent: "delete_transaction",
        target: { merchant: "kopi tuku" },
      },
    },
    state.store,
  );

  assert.equal(result.status, "needs_confirmation");
  assert.equal((state.state.stateData as { action: string }).action, "delete");
  assert.match(result.message, /This will mark it as rejected/);
  assert.deepEqual(result.reply_markup?.inline_keyboard[0][0], {
    text: "Confirm",
    callback_data: "veyra_tx_manage:confirm",
  });
});

test("manage delete multiple matches creates select_transaction with candidate keyboard", async () => {
  const { service } = createService([
    [{ id: "1", telegram_id: "976684739" }],
    [manageTransaction, manageTransaction2],
  ]);
  const state = createManageStateStore();

  const result = await service.handleManagedTransaction(
    {
      telegramUserId: "976684739",
      text: "delete kopi tuku",
      llmResult: {
        intent: "delete_transaction",
        target: { merchant: "kopi tuku" },
      },
    },
    state.store,
  );

  assert.equal(result.status, "needs_selection");
  assert.equal(state.state.stateName, "select_transaction");
  assert.equal((state.state.stateData as { action: string }).action, "delete");
  assert.equal(
    result.reply_markup?.inline_keyboard[1][0].callback_data,
    "veyra_tx_manage:select:2",
  );
});

test("manage select callback without DB state returns invalid", async () => {
  const { service } = createService([[{ id: "1", telegram_id: "976684739" }]]);
  const state = createManageStateStore();

  const result = await service.handleManagedTransaction(
    {
      telegramUserId: "976684739",
      text: "veyra_tx_manage:select:1",
      llmResult: null,
    },
    state.store,
  );

  assert.equal(result.status, "invalid");
  assert.equal(result.reply_markup, null);
  assert.equal(state.state.stateName, "idle");
});

test("manage confirm callback without DB state returns invalid and clears state", async () => {
  const { service } = createService([[{ id: "1", telegram_id: "976684739" }]]);
  const state = createManageStateStore();

  const result = await service.handleManagedTransaction(
    {
      telegramUserId: "976684739",
      text: "veyra_tx_manage:confirm",
      llmResult: null,
    },
    state.store,
  );

  assert.equal(result.status, "invalid");
  assert.deepEqual(state.calls.at(-1), {
    method: "resetState",
    request: { userId: "1" },
  });
});

test("manage invalid callback selection returns invalid and keeps state", async () => {
  const state = createManageStateStore({
    stateName: "select_transaction",
    stateData: { action: "edit", candidates: [manageTransaction] },
  });
  const { service } = createService([[{ id: "1", telegram_id: "976684739" }]]);

  const result = await service.handleManagedTransaction(
    {
      telegramUserId: "976684739",
      text: "veyra_tx_manage:select:9",
      llmResult: null,
    },
    state.store,
  );

  assert.equal(result.status, "invalid");
  assert.equal(state.state.stateName, "select_transaction");
});

test("manage valid callback selection moves to confirm_action", async () => {
  const state = createManageStateStore({
    stateName: "select_transaction",
    stateData: {
      action: "edit",
      candidates: [manageTransaction, manageTransaction2],
      changes: { category: "Food" },
    },
  });
  const { service } = createService([[{ id: "1", telegram_id: "976684739" }]]);

  const result = await service.handleManagedTransaction(
    {
      telegramUserId: "976684739",
      text: "veyra_tx_manage:select:2",
      llmResult: null,
    },
    state.store,
  );

  assert.equal(result.status, "needs_confirmation");
  assert.equal(state.state.stateName, "confirm_action");
  assert.equal(
    (state.state.stateData as { transaction_id: string }).transaction_id,
    "102",
  );
  assert.match(result.message, /Rp27\.000/);
});

test("manage callback confirm without valid DB state cannot mutate", async () => {
  const state = createManageStateStore({
    stateName: "confirm_action",
    stateData: {
      action: "edit",
      transaction_id: "101",
      changes: { category: "Food" },
    },
  });
  const { calls, service } = createService([
    [{ id: "1", telegram_id: "976684739" }],
    [],
  ]);

  const result = await service.handleManagedTransaction(
    {
      telegramUserId: "976684739",
      text: "veyra_tx_manage:confirm",
      llmResult: null,
    },
    state.store,
  );

  assert.equal(result.status, "invalid");
  assert.equal(calls.length, 2);
  assert.doesNotMatch(
    calls.map((call) => call.text).join("\n"),
    /UPDATE transactions/,
  );
  assert.equal(state.state.stateName, "idle");
});

test("manage confirmed edit updates transaction and clears state", async () => {
  const state = createManageStateStore({
    stateName: "confirm_action",
    stateData: {
      action: "edit",
      transaction_id: "101",
      before: manageTransaction,
      changes: { category: "Food" },
    },
  });
  const { calls, service } = createService([
    [{ id: "1", telegram_id: "976684739" }],
    [manageTransaction],
    [],
  ]);

  const result = await service.handleManagedTransaction(
    {
      telegramUserId: "976684739",
      text: "veyra_tx_manage:confirm",
      llmResult: null,
    },
    state.store,
  );

  assert.equal(result.status, "completed");
  assert.equal(result.reply_markup, null);
  assert.match(result.message, /Updated\.\n\nKopi Tuku — Food — Rp25\.000/);
  assert.match(calls[2].text, /UPDATE transactions/);
  assert.match(calls[2].text, /category = \$1/);
  assert.deepEqual(calls[2].values, ["Food", "101", "1"]);
  assert.equal(state.state.stateName, "idle");
});

test("manage confirmed delete sets rejected and clears state", async () => {
  const state = createManageStateStore({
    stateName: "confirm_action",
    stateData: {
      action: "delete",
      transaction_id: "101",
      before: manageTransaction,
    },
  });
  const { calls, service } = createService([
    [{ id: "1", telegram_id: "976684739" }],
    [manageTransaction],
    [],
  ]);

  const result = await service.handleManagedTransaction(
    {
      telegramUserId: "976684739",
      text: "veyra_tx_manage:confirm",
      llmResult: null,
    },
    state.store,
  );

  assert.equal(result.status, "completed");
  assert.match(result.message, /Deleted\./);
  assert.match(calls[2].text, /status = 'rejected'/);
  assert.deepEqual(calls[2].values, ["101", "1"]);
  assert.equal(state.state.stateName, "idle");
});

test("manage request statePayload alone cannot trigger mutation", async () => {
  const { calls, service } = createService([
    [{ id: "1", telegram_id: "976684739" }],
  ]);
  const state = createManageStateStore();

  const result = await service.handleManagedTransaction(
    {
      telegramUserId: "976684739",
      text: "yes",
      statePayload: {
        state_name: "confirm_action",
        state_data: { action: "delete", transaction_id: "101" },
      },
      llmResult: null,
    },
    state.store,
  );

  assert.equal(result.status, "invalid");
  assert.equal(calls.length, 1);
});

test("manage callback data alone cannot trigger mutation", async () => {
  const { calls, service } = createService([
    [{ id: "1", telegram_id: "976684739" }],
  ]);
  const state = createManageStateStore();

  const result = await service.handleManagedTransaction(
    {
      telegramUserId: "976684739",
      text: "veyra_tx_manage:confirm",
      llmResult: null,
    },
    state.store,
  );

  assert.equal(result.status, "invalid");
  assert.equal(calls.length, 1);
});

test("manage normal typed number is not accepted as selection", async () => {
  const state = createManageStateStore({
    stateName: "select_transaction",
    stateData: { action: "edit", candidates: [manageTransaction] },
  });
  const { service } = createService([[{ id: "1", telegram_id: "976684739" }]]);

  const result = await service.handleManagedTransaction(
    { telegramUserId: "976684739", text: "1", llmResult: null },
    state.store,
  );

  assert.equal(result.status, "invalid");
  assert.equal(state.state.stateName, "select_transaction");
});

test("manage normal typed yes is not accepted as confirmation", async () => {
  const state = createManageStateStore({
    stateName: "confirm_action",
    stateData: {
      action: "delete",
      transaction_id: "101",
      before: manageTransaction,
    },
  });
  const { service } = createService([[{ id: "1", telegram_id: "976684739" }]]);

  const result = await service.handleManagedTransaction(
    { telegramUserId: "976684739", text: "yes", llmResult: null },
    state.store,
  );

  assert.equal(result.status, "invalid");
  assert.equal(state.state.stateName, "confirm_action");
});

test("manage cannot edit another user transaction by target id", async () => {
  const { calls, service } = createService([
    [{ id: "1", telegram_id: "976684739" }],
    [],
  ]);
  const state = createManageStateStore();

  const result = await service.handleManagedTransaction(
    {
      telegramUserId: "976684739",
      text: "edit transaction 999",
      llmResult: {
        intent: "edit_transaction",
        target: { id: 999 },
        changes: { category: "Food" },
      },
    },
    state.store,
  );

  assert.equal(result.status, "not_found");
  assert.match(calls[1].text, /AND id::text = \$2/);
  assert.deepEqual(calls[1].values, ["1", "999"]);
});

test("manage expired state resets to idle", async () => {
  const state = createManageStateStore({
    stateName: "confirm_action",
    stateData: {
      action: "delete",
      transaction_id: "101",
      before: manageTransaction,
    },
    expiresAt: "2000-01-01T00:00:00.000Z",
  });
  const { service } = createService([[{ id: "1", telegram_id: "976684739" }]]);

  const result = await service.handleManagedTransaction(
    {
      telegramUserId: "976684739",
      text: "veyra_tx_manage:confirm",
      llmResult: null,
    },
    state.store,
  );

  assert.equal(result.status, "invalid");
  assert.equal(
    result.message,
    "This edit/delete session expired. Please start again.",
  );
  assert.equal(state.state.stateName, "idle");
});

test("formats experimental set category callback data only in experimental mode", async () => {
  const { service } = createService([[pendingTransaction]]);

  const result = await service.buildCategoryOptions({
    pendingTransactionId: "pending-1",
    callbackMode: "experimental",
    userId: "user-1",
  });

  const buttons = result.replyMarkup?.inline_keyboard.flat() ?? [];

  assert.deepEqual(
    buttons.map((button) => button.callback_data),
    [
      "tx_set_category:pending-1:food",
      "tx_set_category:pending-1:transport",
      "tx_set_category:pending-1:groceries",
      "tx_set_category:pending-1:bills",
      "tx_set_category:pending-1:health_and_beauty",
      "tx_set_category:pending-1:shopping",
      "tx_set_category:pending-1:entertainment",
      "tx_set_category:pending-1:transfer",
      "tx_set_category:pending-1:other",
    ],
  );
});

test("keeps every AI result pending and stores only a validated proposal", async () => {
  const { calls, service } = createService([
    [{ id: "1", telegram_id: "976684739" }],
    [{ category: "Food" }],
    [{ id: "import-1", transaction_id: null, status: "needs_ai" }],
    [{ id: "123" }],
    [{ id: "import-1" }],
  ]);

  const result = await service.resolveEmailTransactionReview({
    telegramUserId: "976684739",
    reviewToken: "gmail-message-id",
    email: authenticatedUnknownKromEmail.email,
    transactionCandidate: aiCandidate,
    resolution: { category: "Food", confidence: 98, resolver: "llm" },
    templateProposal: learnedProposal,
  });

  assert.equal(result.status, "pending");
  assert.equal(result.transaction?.status, "pending");
  assert.match(calls[2].text, /FOR UPDATE/);
  assert.equal(calls[3].values[8], "pending");
  const rawPayload = calls[3].values[10] as Record<string, unknown>;
  assert.equal(rawPayload.parserSource, "ai");
  assert.equal("emailText" in rawPayload, false);
  assert.equal("emailHtml" in rawPayload, false);
  assert.deepEqual(rawPayload.email, {
    messageId: "gmail-learned-1",
    from: "alerts@krom.id",
    authentication: authenticatedUnknownKromEmail.email.authentication,
  });
  assert.ok(rawPayload.validatedTemplate);
  assert.match(calls[4].text, /UPDATE transaction_imports/);
  assert.deepEqual(calls[4].values, ["123", rawPayload, "import-1"]);
});

test("reuses the import-linked pending transaction on an initial AI retry", async () => {
  const existingTransaction = {
    id: "123",
    user_id: "1",
    transaction_type: "expense",
    amount: "25000",
    merchant: "Kopi Tuku",
    merchant_normalized: "Kopi Tuku",
    category: "Food",
    transaction_date: "2026-07-27T02:30:00.000Z",
    status: "pending",
    confidence: 98,
  };
  const { calls, service, transactionEvents } = createService([
    [{ id: "1", telegram_id: "976684739" }],
    [{ category: "Food" }],
    [{ id: "import-1", transaction_id: null, status: "needs_ai" }],
    [{ id: "123" }],
    [{ id: "import-1" }],
    [{ id: "1", telegram_id: "976684739" }],
    [{ category: "Food" }],
    [{ id: "import-1", transaction_id: "123", status: "pending" }],
    [existingTransaction],
  ]);

  const first = await service.resolveEmailTransactionReview(
    validAiReviewRequest(),
  );
  const retry = await service.resolveEmailTransactionReview(
    validAiReviewRequest(),
  );

  assert.equal(first.transaction?.id, "123");
  assert.equal(retry.transaction?.id, "123");
  assert.equal(
    calls.filter((call) => /INSERT INTO transactions/.test(call.text)).length,
    1,
  );
  assert.equal(
    calls.filter((call) => /FOR UPDATE/.test(call.text)).length,
    2,
  );
  assert.deepEqual(transactionEvents, ["begin", "commit", "begin", "commit"]);
});

test("rolls back an initial AI insert when the import cannot be attached", async () => {
  const { calls, service, transactionEvents } = createService([
    [{ id: "1", telegram_id: "976684739" }],
    [{ category: "Food" }],
    [{ id: "import-1", transaction_id: null, status: "needs_ai" }],
    [{ id: "123" }],
    [],
  ]);

  await assert.rejects(
    () => service.resolveEmailTransactionReview(validAiReviewRequest()),
    BadRequestException,
  );

  assert.equal(
    calls.filter((call) => /INSERT INTO transactions/.test(call.text)).length,
    1,
  );
  assert.match(calls[4].text, /UPDATE transaction_imports/);
  assert.match(calls[4].text, /RETURNING id/);
  assert.deepEqual(transactionEvents, ["begin", "rollback"]);
});

test("returns edit-details markup for n8n interception", async () => {
  const result = await resolveValidAiReview();
  assert.equal(result.actions?.editDetails.action, "edit_email_details");
  assert.deepEqual(result.replyMarkup?.inline_keyboard, [
    [
      { text: "Save", callback_data: "save_transaction:123" },
      { text: "Edit Details", callback_data: "edit_email_details:123" },
    ],
    [
      { text: "Change Category", callback_data: "change_categories:123" },
      { text: "Cancel", callback_data: "cancel_transaction:123" },
    ],
  ]);
});

test("updates the same pending row after a valid AI correction", async () => {
  const { calls, service } = createService([
    [{ id: "1", telegram_id: "976684739" }],
    [{ id: "123", user_id: "1", source: "email", status: "pending" }],
    [{ category: "Food" }],
    [{ id: "123" }],
  ]);

  const result = await service.resolveEmailTransactionReview({
    telegramUserId: "976684739",
    reviewToken: "gmail-message-id",
    transactionId: "123",
    email: correctionEmail,
    transactionCandidate: { ...aiCandidate, amount: 30000 },
    resolution: { category: "Food", confidence: 98, resolver: "llm" },
    templateProposal: correctedKromProposal,
  });

  assert.equal(result.transaction?.id, "123");
  assert.match(calls[3].text, /UPDATE transactions/);
  assert.match(calls[3].text, /status = 'pending'/);
  assert.match(calls[3].text, /source = 'email'/);
  assert.equal(calls[3].values[0], "1");
  assert.equal(calls[3].values[2], 30000);
  assert.equal(calls[3].values[11], "123");
});

test("does not mutate a pending row when corrected output is invalid", async () => {
  const { calls, service } = createService([
    [{ id: "1", telegram_id: "976684739" }],
    [{ id: "123", user_id: "1", source: "email", status: "pending" }],
  ]);

  await assert.rejects(
    () => service.resolveEmailTransactionReview(invalidCorrection),
    BadRequestException,
  );
  assert.equal(
    calls.some((call) => /UPDATE transactions/.test(call.text)),
    false,
  );
});

test("rejects negative initial AI amounts before inserting", async () => {
  for (const amount of [-25000, "-25.000", "Rp -25.000", "Rp −25.000"]) {
    const { calls, service } = createService([
      [{ id: "1", telegram_id: "976684739" }],
      [{ category: "Food" }],
      [{ id: "import-1", transaction_id: null, status: "needs_ai" }],
      [{ id: "123" }],
      [{ id: "import-1" }],
    ]);

    await assert.rejects(
      () =>
        service.resolveEmailTransactionReview(
          validAiReviewRequest({
            transactionCandidate: { ...aiCandidate, amount },
          }),
        ),
      BadRequestException,
    );
    assert.equal(
      calls.some((call) => /INSERT INTO transactions/.test(call.text)),
      false,
    );
  }
});

test("rejects negative AI correction amounts before updating", async () => {
  for (const amount of [-30000, "-30.000", "Rp -25.000", "Rp −25.000"]) {
    const { calls, service } = createService([
      [{ id: "1", telegram_id: "976684739" }],
      [{ id: "123", user_id: "1", source: "email", status: "pending" }],
      [{ category: "Food" }],
      [{ id: "123" }],
    ]);

    await assert.rejects(
      () =>
        service.resolveEmailTransactionReview(
          validAiReviewRequest({
            transactionId: "123",
            transactionCandidate: { ...aiCandidate, amount },
          }),
        ),
      BadRequestException,
    );
    assert.equal(
      calls.some((call) => /UPDATE transactions/.test(call.text)),
      false,
    );
  }
});

test("accepts a positive formatted AI amount", async () => {
  const { service } = createService([
    [{ id: "1", telegram_id: "976684739" }],
    [{ category: "Food" }],
    [{ id: "import-1", transaction_id: null, status: "needs_ai" }],
    [{ id: "123" }],
    [{ id: "import-1" }],
  ]);

  const result = await service.resolveEmailTransactionReview(
    validAiReviewRequest({
      transactionCandidate: { ...aiCandidate, amount: "Rp 25.000" },
    }),
  );

  assert.equal(result.transaction?.amount, 25000);
});

test("records needs_review when n8n reports AI failure", async () => {
  const { calls, service } = createService([
    [{ id: "1", telegram_id: "976684739" }],
    [],
  ]);

  const result = await service.resolveEmailTransactionReview({
    telegramUserId: "976684739",
    reviewToken: "gmail-learned-1",
    email: authenticatedUnknownKromEmail.email,
    aiError: "model unavailable",
  });

  assert.equal(result.status, "needs_review");
  assert.equal(result.reason, "ai_failed");
  assert.match(calls[1].text, /UPDATE transaction_imports/);
  assert.match(calls[2].text, /UPDATE email_parse_attempts/);
  assert.deepEqual(calls[1].values, [
    "1",
    "gmail-learned-1",
    "model unavailable",
  ]);
  assert.deepEqual(calls[2].values, calls[1].values);
  assert.equal(
    calls.some((call) => /INSERT INTO transactions/.test(call.text)),
    false,
  );
});

test("keeps AI result pending when the template proposal is invalid", async () => {
  const { calls, service } = createService([
    [{ id: "1", telegram_id: "976684739" }],
    [{ category: "Food" }],
    [{ id: "import-1", transaction_id: null, status: "needs_ai" }],
    [{ id: "123" }],
    [{ id: "import-1" }],
  ]);

  const result = await service.resolveEmailTransactionReview(
    validAiReviewRequest({
      templateProposal: {
        ...learnedProposal,
        requiredAnchors: ["missing anchor"],
      },
    }),
  );

  assert.equal(result.status, "pending");
  const rawPayload = calls[3].values[10] as Record<string, unknown>;
  assert.equal(rawPayload.validatedTemplate, null);
});

test("keeps AI result pending when the template proposal is malformed", async () => {
  const { calls, service } = createService([
    [{ id: "1", telegram_id: "976684739" }],
    [{ category: "Food" }],
    [{ id: "import-1", transaction_id: null, status: "needs_ai" }],
    [{ id: "123" }],
    [{ id: "import-1" }],
  ]);

  const result = await service.resolveEmailTransactionReview(
    validAiReviewRequest({
      templateProposal: {} as EmailParserTemplateProposalDto,
    }),
  );

  assert.equal(result.status, "pending");
  const insert = calls.find((call) => /INSERT INTO transactions/.test(call.text));
  const rawPayload = insert?.values[10] as Record<string, unknown>;
  assert.equal(rawPayload.validatedTemplate, null);
});

test("resolves medium confidence email review as pending with production actions", async () => {
  const { calls, service } = createService([
    [{ id: "1", telegram_id: "976684739" }],
    [{ category: "Food" }],
    [{ id: "import-1", transaction_id: null, status: "needs_ai" }],
    [{ id: "123" }],
    [{ id: "import-1" }],
  ]);

  const result = await service.resolveEmailTransactionReview({
    telegramUserId: "976684739",
    email: authenticatedUnknownKromEmail.email,
    transactionCandidate: {
      source: "email",
      bank: "bca",
      transactionType: "expense",
      amount: 25000,
      merchant: "TUKU",
      merchantNormalized: "tuku",
      transactionDate: "2026-06-25T00:00:00+07:00",
      rawPayload: {},
    },
    resolution: {
      category: "Food",
      confidence: 84,
      resolver: "llm",
    },
  });

  assert.equal(result.status, "pending");
  assert.equal(result.transaction?.status, "pending");
  assert.equal(result.actions?.confirm.action, "save_transaction");
  assert.equal(result.actions?.confirm.transactionId, "123");
  assert.equal(result.actions?.cancel.action, "cancel_transaction");
  assert.equal(result.actions?.changeCategory.action, "change_categories");
  assert.deepEqual(result.replyMarkup?.inline_keyboard, [
    [
      { text: "Save", callback_data: "save_transaction:123" },
      { text: "Edit Details", callback_data: "edit_email_details:123" },
    ],
    [
      { text: "Change Category", callback_data: "change_categories:123" },
      { text: "Cancel", callback_data: "cancel_transaction:123" },
    ],
  ]);
  assert.equal(calls[3].values[8], "pending");
  assert.equal(calls[3].values[9], 84);
  assert.equal(
    calls.some((call) => /merchant_aliases|category_rules/.test(call.text)),
    false,
  );
});

test("resolves low confidence email review as pending with LLM category", async () => {
  const { calls, service } = createService([
    [{ id: "1", telegram_id: "976684739" }],
    [{ category: "Food" }],
    [{ id: "import-1", transaction_id: null, status: "needs_ai" }],
    [{ id: "123" }],
    [{ id: "import-1" }],
  ]);

  const result = await service.resolveEmailTransactionReview({
    telegramUserId: "976684739",
    email: authenticatedUnknownKromEmail.email,
    transactionCandidate: {
      source: "email",
      transactionType: "expense",
      amount: 25000,
      merchant: "TUKU",
      merchantNormalized: "tuku",
      transactionDate: "2026-06-25T00:00:00+07:00",
      rawPayload: {},
    },
    resolution: {
      category: "Food",
      confidence: 0.74,
      resolver: "llm",
    },
  });

  assert.equal(result.status, "pending");
  assert.equal(result.reason, undefined);
  assert.equal(result.transaction?.status, "pending");
  assert.equal(result.transaction?.category, "Food");
  assert.equal(result.transaction?.confidence, 74);
  assert.equal(result.actions?.confirm.transactionId, "123");
  assert.equal(result.replyMarkup?.inline_keyboard[0][0].text, "Save");
  assert.equal(calls[3].values[8], "pending");
  assert.equal(calls[3].values[9], 74);
});

test("resolves low confidence email review with unknown LLM category as pending", async () => {
  const { calls, service } = createService([
    [{ id: "1", telegram_id: "976684739" }],
    [],
    [{ id: "import-1", transaction_id: null, status: "needs_ai" }],
    [{ id: "123" }],
    [{ id: "import-1" }],
  ]);

  const result = await service.resolveEmailTransactionReview({
    telegramUserId: "976684739",
    email: authenticatedUnknownKromEmail.email,
    transactionCandidate: {
      source: "email",
      transactionType: "expense",
      amount: 25000,
      merchant: "TUKU",
      merchantNormalized: "tuku",
      transactionDate: "2026-06-25T00:00:00+07:00",
      rawPayload: {},
    },
    resolution: {
      category: "LLM Made Category",
      confidence: 0.74,
      resolver: "llm",
    },
  });

  assert.equal(result.status, "pending");
  assert.equal(result.transaction?.category, "LLM Made Category");
  assert.equal(calls[3].values[5], "LLM Made Category");
  assert.equal(calls[3].values[8], "pending");
});

test("keeps high confidence AI result pending when category is not in budgets", async () => {
  const { calls, service } = createService([
    [{ id: "1", telegram_id: "976684739" }],
    [],
    [{ id: "import-1", transaction_id: null, status: "needs_ai" }],
    [{ id: "123" }],
    [{ id: "import-1" }],
  ]);

  const result = await service.resolveEmailTransactionReview({
    telegramUserId: "976684739",
    email: authenticatedUnknownKromEmail.email,
    transactionCandidate: {
      source: "email",
      transactionType: "expense",
      amount: 25000,
      merchant: "TUKU",
      merchantNormalized: "tuku",
      transactionDate: "2026-06-25T00:00:00+07:00",
      rawPayload: {},
    },
    resolution: {
      category: "LLM Made Category",
      confidence: 95,
      resolver: "llm",
    },
  });

  assert.equal(result.status, "pending");
  assert.equal(result.transaction?.category, "LLM Made Category");
  assert.equal(result.transaction?.confidence, 95);
  assert.match(calls[1].text, /FROM budgets/);
  assert.match(calls[3].text, /INSERT INTO transactions/);
});

test("returns safe email review response when telegram user is not found", async () => {
  const { calls, service } = createService([[]]);

  const result = await service.resolveEmailTransactionReview({
    telegramUserId: "976684739",
    email: authenticatedUnknownKromEmail.email,
    transactionCandidate: {
      source: "email",
      transactionType: "expense",
      amount: 25000,
      merchant: "TUKU",
      rawPayload: {},
    },
    resolution: {
      category: "Food",
      confidence: 95,
    },
  });

  assert.equal(result.status, "needs_review");
  assert.equal(result.reason, "user_not_found");
  assert.equal(result.message, "Telegram user was not found.");
  assert.match(calls[0].text, /FROM telegram_users/);
  assert.equal(calls.length, 1);
});

test("rejects invalid email review source", async () => {
  const { service } = createService([[{ id: "1", telegram_id: "976684739" }]]);

  await assert.rejects(
    () =>
      service.resolveEmailTransactionReview({
        telegramUserId: "976684739",
        email: authenticatedUnknownKromEmail.email,
        transactionCandidate: {
          source: "manual",
          transactionType: "expense",
          amount: 25000,
          merchant: "TUKU",
          rawPayload: {},
        },
        resolution: {
          category: "Food",
          confidence: 95,
        },
      }),
    BadRequestException,
  );
});

test("rejects invalid email review amount", async () => {
  const { service } = createService([[{ id: "1", telegram_id: "976684739" }]]);

  await assert.rejects(
    () =>
      service.resolveEmailTransactionReview({
        telegramUserId: "976684739",
        email: authenticatedUnknownKromEmail.email,
        transactionCandidate: {
          source: "email",
          transactionType: "expense",
          amount: 0,
          merchant: "TUKU",
          rawPayload: {},
        },
        resolution: {
          category: "Food",
          confidence: 95,
        },
      }),
    BadRequestException,
  );
});

test("uses a learned template after hard-coded parsers and skips AI", async () => {
  const templates = createTemplateRepository([learnedTemplate]);
  const { service } = createService(
    [
      [],
      [{ canonical_name: "Kopi Tuku" }],
      [{ category: "Food" }],
      [{ id: "import-1" }],
      [{ id: "tx-1" }],
      [],
      [],
    ],
    undefined,
    undefined,
    templates.repository,
  );

  const result = await service.handleEmailTransaction(
    authenticatedUnknownKromEmail,
  );

  assert.equal(result.status, "confirmed");
  assert.equal(result.templateKey, "learned-krom-qris");
  assert.equal(result.parsed?.raw.parserSource, "learned");
  assert.equal(templates.calls[0].method, "findActive");
  assert.equal(templates.calls[1].method, "markMatched");
});

test("learned auto-save succeeds when marking the template match fails", async () => {
  const templates = createTemplateRepository([learnedTemplate]);
  templates.repository.markMatched = async () => {
    throw new Error("db unavailable");
  };
  const { service } = createService(
    [
      [],
      [{ canonical_name: "Kopi Tuku" }],
      [{ category: "Food" }],
      [{ id: "import-1" }],
      [{ id: "tx-1" }],
      [],
      [],
    ],
    undefined,
    undefined,
    templates.repository,
  );

  const result = await service.handleEmailTransaction(
    authenticatedUnknownKromEmail,
  );

  assert.equal(result.status, "confirmed");
  assert.equal(result.transaction?.id, "tx-1");
});

test("returns needs_ai for a likely transaction with no deterministic parser", async () => {
  const templates = createTemplateRepository([]);
  const { service } = createService(
    [[], [{ id: "import-1" }], []],
    undefined,
    undefined,
    templates.repository,
  );

  const result = await service.handleEmailTransaction(
    authenticatedUnknownBankTransaction,
  );

  assert.equal(result.status, "needs_ai");
  assert.deepEqual(result.aiRequest, {
    reviewToken: "gmail-unknown-1",
    reason: "unsupported_template",
  });
  assert.equal("emailText" in (result.aiRequest ?? {}), false);
});

test("does not auto-save a learned result without aligned sender authentication", async () => {
  const templates = createTemplateRepository([learnedTemplate]);
  const { service } = createService(
    [[], [{ id: "import-1" }], []],
    undefined,
    undefined,
    templates.repository,
  );

  const result = await service.handleEmailTransaction(
    unauthenticatedMatchingEmail,
  );

  assert.equal(result.status, "needs_review");
  assert.equal(
    result.reason,
    "sender authentication is required for automatic import",
  );
});

test("hard-coded parser handles confirmed Krom QRIS email without learned lookup", async () => {
  const templates = createTemplateRepository([learnedTemplate]);
  const { calls, service } = createService(
    [
      [],
      [{ canonical_name: "Kopi Tuku Canonical" }],
      [{ category: "Food" }],
      [{ id: "import-1" }],
      [{ id: "tx-email" }],
      [],
      [],
    ],
    undefined,
    undefined,
    templates.repository,
  );

  const result = await service.handleEmailTransaction({
    telegramUserId: "976684739",
    userId: 1,
    source: "email",
    email: {
      messageId: "gmail-qris",
      threadId: "thread-qris",
      from: "no-reply@krom.id",
      subject: "Transaksi QRIS berhasil",
      date: "2026-06-22T10:00:00+07:00",
      emailText:
        "Transaksi QRIS berhasil. Merchant: Kopi Tuku Jumlah: Rp25.000",
    },
  });

  assert.equal(result.status, "confirmed");
  assert.equal(result.provider, "Krom");
  assert.equal(result.templateKey, "krom-qris-payment");
  assert.equal(result.transaction?.id, "tx-email");
  assert.equal(result.transaction?.category, "Food");
  assert.equal(result.transaction?.merchant, "Kopi Tuku");
  assert.equal(result.transaction?.merchantNormalized, "Kopi Tuku Canonical");
  assert.match(result.telegram.text, /Merchant: Kopi Tuku Canonical/);
  assert.equal(calls.length, 8);
  assert.match(calls[2].text, /FROM category_rules/);
  assert.deepEqual(calls[2].values, ["1", "Kopi Tuku Canonical", "Kopi Tuku"]);
  assert.match(calls[4].text, /INSERT INTO transactions/);
  assert.deepEqual(calls[4].values.slice(0, 8), [
    "1",
    "expense",
    25000,
    "Kopi Tuku",
    "Kopi Tuku Canonical",
    "Food",
    "2026-06-22T03:00:00.000Z",
    97,
  ]);
  assert.deepEqual(templates.calls, []);
});

test("falls back to emailHtml when emailText is not parseable", async () => {
  const { calls, service } = createService([
    [],
    [{ canonical_name: "Kopi Tuku Canonical" }],
    [{ category: "Food" }],
    [{ id: "import-html" }],
    [{ id: "tx-email-html" }],
    [],
    [],
  ]);

  const result = await service.handleEmailTransaction({
    telegramUserId: "976684739",
    userId: 1,
    source: "email",
    email: {
      messageId: "gmail-qris-html",
      from: "no-reply@krom.id",
      subject: "Transaksi QRIS berhasil",
      date: "2026-06-22T10:00:00+07:00",
      emailText: "Open this email in a client that supports HTML.",
      emailHtml:
        "<p>Transaksi QRIS berhasil.</p><p>Merchant: Kopi Tuku</p><p>Jumlah: Rp25.000</p>",
    },
  });

  assert.equal(result.status, "confirmed");
  assert.equal(result.provider, "Krom");
  assert.equal(result.templateKey, "krom-qris-payment");
  assert.equal(result.transaction?.id, "tx-email-html");
  assert.equal(result.parsed?.merchant, "Kopi Tuku");
  assert.deepEqual(calls[2].values, ["1", "Kopi Tuku Canonical", "Kopi Tuku"]);
});

test("returns needs_review for BCA known template without category", async () => {
  const { calls, service } = createService([
    [],
    [{ canonical_name: "Toko Buku" }],
    [],
    [{ id: "import-review" }],
    [],
  ]);

  const result = await service.handleEmailTransaction({
    telegramUserId: "976684739",
    userId: 1,
    source: "email",
    email: {
      messageId: "gmail-bca",
      from: "card@bca.co.id",
      subject: "Notifikasi Transaksi",
      date: "2026-06-22T10:00:00+07:00",
      emailText:
        "Notifikasi Transaksi Merchant/ATM TOKO BUKU Jenis Transaksi Pembelian Sejumlah Rp123.456",
    },
  });

  assert.equal(result.status, "needs_review");
  assert.equal(result.provider, "BCA");
  assert.equal(result.reason, "category could not be resolved");
  assert.equal(result.transaction, undefined);
  assert.match(calls[3].text, /INSERT INTO transaction_imports/);
  assert.match(calls[4].text, /INSERT INTO email_parse_attempts/);
});

test("returns needs_review for known email when merchant alias is missing", async () => {
  const { calls, service } = createService([
    [],
    [],
    [{ id: "import-alias-review" }],
    [],
  ]);

  const result = await service.handleEmailTransaction({
    telegramUserId: "976684739",
    userId: 1,
    source: "email",
    email: {
      messageId: "gmail-bca-missing-alias",
      from: "card@bca.co.id",
      subject: "Notifikasi Transaksi",
      date: "2026-06-25T00:05:42+07:00",
      emailText:
        "Notifikasi Transaksi Merchant / ATM SHOPEE.CO.ID Jenis Transaksi E-COMMERCE Sejumlah : Rp243.000,00",
    },
  });

  assert.equal(result.status, "needs_review");
  assert.equal(result.provider, "BCA");
  assert.equal(result.reason, "merchant alias could not be resolved");
  assert.equal(result.transaction, undefined);
  assert.equal(result.parsed?.merchant, "SHOPEE.CO.ID");
  assert.match(result.telegram.text, /Merchant: SHOPEE\.CO\.ID/);
  assert.equal(calls.length, 4);
  assert.match(calls[1].text, /FROM merchant_aliases/);
  assert.doesNotMatch(calls[2].text, /FROM category_rules/);
  assert.match(calls[2].text, /INSERT INTO transaction_imports/);
  assert.match(calls[3].text, /INSERT INTO email_parse_attempts/);
});

test("returns needs_ai for a likely Mandiri transaction with no parser", async () => {
  const { calls, service } = createService([
    [],
    [{ id: "import-mandiri" }],
    [],
  ]);

  const result = await service.handleEmailTransaction({
    telegramUserId: "976684739",
    userId: 1,
    source: "email",
    email: {
      messageId: "gmail-mandiri",
      from: "bankmandiri@bankmandiri.co.id",
      subject: "Mandiri Transaction",
      date: "2026-06-22T10:00:00+07:00",
      emailText: "Mandiri Transaction berhasil sebesar Rp50.000",
    },
  });

  assert.equal(result.status, "needs_ai");
  assert.equal(result.provider, "Mandiri");
  assert.equal(result.templateKey, null);
  assert.deepEqual(result.aiRequest, {
    reviewToken: "gmail-mandiri",
    reason: "unsupported_template",
  });
  assert.equal(calls.length, 3);
});

test("returns duplicate for existing Gmail message import", async () => {
  const templates = createTemplateRepository([]);
  const { calls, service } = createService(
    [
      [
        {
          id: "import-existing",
          transaction_id: "tx-existing",
          status: "confirmed",
        },
      ],
    ],
    undefined,
    undefined,
    templates.repository,
  );

  const result = await service.handleEmailTransaction({
    ...authenticatedUnknownBankTransaction,
    email: {
      ...authenticatedUnknownBankTransaction.email,
      messageId: "gmail-existing",
    },
  });

  assert.equal(result.status, "duplicate");
  assert.equal(result.transaction, undefined);
  assert.equal(result.aiRequest, undefined);
  assert.deepEqual(templates.calls, []);
  assert.equal(calls.length, 1);
});

test("repeated Gmail delivery returns the existing pending review", async () => {
  const { service } = createService([
    [{ id: "import-1", transaction_id: "123", status: "pending" }],
    [pendingAiTransaction],
  ]);

  const result = await service.handleEmailTransaction(originalAiEmail);

  assert.equal(result.status, "needs_review");
  assert.equal(result.transaction?.id, "123");
});

test("repeated Gmail delivery returns the existing AI handoff", async () => {
  const { calls, service } = createService([
    [{ id: "import-1", transaction_id: null, status: "needs_ai" }],
  ]);

  const result = await service.handleEmailTransaction(originalAiEmail);

  assert.equal(result.status, "needs_ai");
  assert.deepEqual(result.aiRequest, {
    reviewToken: "gmail-learned-1",
    reason: "unsupported_template",
  });
  assert.equal(calls.length, 1);
});

test("repeated rejected Gmail delivery remains a terminal duplicate", async () => {
  const { calls, service } = createService([
    [{ id: "import-1", transaction_id: "123", status: "rejected" }],
  ]);

  const result = await service.handleEmailTransaction(originalAiEmail);

  assert.equal(result.status, "duplicate");
  assert.equal(result.transaction, undefined);
  assert.equal(calls.length, 1);
});

test("does not include an AI handoff when Gmail idempotency wins an insert race", async () => {
  const templates = createTemplateRepository([]);
  const { calls, service } = createService(
    [[], []],
    undefined,
    undefined,
    templates.repository,
  );

  const result = await service.handleEmailTransaction(
    authenticatedUnknownBankTransaction,
  );

  assert.equal(result.status, "duplicate");
  assert.equal(result.aiRequest, undefined);
  assert.equal(calls.length, 2);
});

test("missing amount in known email returns parse_failed instead of confirmed", async () => {
  const { calls, service } = createService([
    [],
    [{ id: "import-parse-failed" }],
    [],
  ]);

  const result = await service.handleEmailTransaction({
    telegramUserId: "976684739",
    userId: 1,
    source: "email",
    email: {
      messageId: "gmail-missing-amount",
      from: "no-reply@krom.id",
      subject: "Transaksi QRIS berhasil",
      date: "2026-06-22T10:00:00+07:00",
      emailText: "Transaksi QRIS berhasil. Merchant: Kopi Tuku Jumlah:",
    },
  });

  assert.equal(result.status, "parse_failed");
  assert.equal(result.reason, "amount must exist and be positive");
  assert.equal(result.transaction, undefined);
  assert.equal(calls.length, 3);
});

function spyOnWatchdog(
  service: TransactionService,
  response: TransactionWatchdogResponseDto = { notifications: [] },
) {
  const calls: Array<string | number> = [];

  service.evaluateTransactionWatchdog = async (transactionId) => {
    calls.push(transactionId);
    return response;
  };

  return calls;
}

test("manual transaction save triggers watchdog", async () => {
  const { service } = createService([[], [{ id: "tx-manual" }]]);
  const watchdogCalls = spyOnWatchdog(service);

  const result = await service.handleManualTransaction({
    userId: 1,
    source: "manual",
    llmResult: {
      transaction_type: "expense",
      amount: 25000,
      merchant: "kopi tuku",
      category: "Coffee",
      confidence: 95,
    },
  });

  assert.equal(result.status, "confirmed");
  assert.deepEqual(watchdogCalls, ["tx-manual"]);
});

test("email confirmed save triggers watchdog", async () => {
  const { service } = createService([
    [],
    [{ canonical_name: "Kopi Tuku Canonical" }],
    [{ category: "Food" }],
    [{ id: "import-1" }],
    [{ id: "tx-email" }],
    [],
    [],
  ]);
  const watchdogCalls = spyOnWatchdog(service);

  const result = await service.handleEmailTransaction({
    telegramUserId: "976684739",
    userId: 1,
    source: "email",
    email: {
      messageId: "gmail-watchdog-qris",
      from: "no-reply@krom.id",
      subject: "Transaksi QRIS berhasil",
      date: "2026-06-22T10:00:00+07:00",
      emailText:
        "Transaksi QRIS berhasil. Merchant: Kopi Tuku Jumlah: Rp25.000",
    },
  });

  assert.equal(result.status, "confirmed");
  assert.deepEqual(watchdogCalls, ["tx-email"]);
});

test("email review AI result skips watchdog until confirmed", async () => {
  const { service } = createService([
    [{ id: "1", telegram_id: "976684739" }],
    [{ category: "Food" }],
    [{ id: "import-1", transaction_id: null, status: "needs_ai" }],
    [{ id: "tx-review" }],
    [{ id: "import-1" }],
  ]);
  const watchdogCalls = spyOnWatchdog(service);

  const result = await service.resolveEmailTransactionReview({
    telegramUserId: "976684739",
    email: authenticatedUnknownKromEmail.email,
    transactionCandidate: {
      source: "email",
      transactionType: "expense",
      amount: 25000,
      merchant: "TUKU",
      merchantNormalized: "tuku",
      transactionDate: "2026-06-25T00:00:00+07:00",
      rawPayload: {},
    },
    resolution: { category: "Food", confidence: 95 },
  });

  assert.equal(result.status, "pending");
  assert.deepEqual(watchdogCalls, []);
});

test("manage edit confirm triggers watchdog", async () => {
  const state = createManageStateStore({
    stateName: "confirm_action",
    stateData: {
      action: "edit",
      transaction_id: "101",
      changes: { category: "Food" },
    },
  });
  const { service } = createService([
    [{ id: "1", telegram_id: "976684739" }],
    [manageTransaction],
    [],
  ]);
  const watchdogCalls = spyOnWatchdog(service);

  const result = await service.handleManagedTransaction(
    {
      telegramUserId: "976684739",
      text: "veyra_tx_manage:confirm",
      llmResult: null,
    },
    state.store,
  );

  assert.equal(result.status, "completed");
  assert.deepEqual(watchdogCalls, ["101"]);
});

test("material edit disables the learned template", async () => {
  const templates = createTemplateRepository();
  const state = createManageStateStore({
    stateName: "confirm_action",
    stateData: {
      action: "edit",
      transaction_id: "123",
      before: learnedParsedTransaction,
      changes: { amount: 30000 },
    },
  });
  const { service } = createService(
    [
      [{ id: "1", telegram_id: "976684739" }],
      [learnedParsedTransaction],
      [],
      [],
    ],
    undefined,
    undefined,
    templates.repository,
  );
  spyOnWatchdog(service);

  const result = await service.handleManagedTransaction(
    {
      telegramUserId: "976684739",
      text: "veyra_tx_manage:confirm",
      llmResult: null,
    },
    state.store,
  );

  assert.equal(result.status, "completed");
  assert.deepEqual(
    templates.calls.filter((call) => call.method === "disable"),
    [{ method: "disable", input: { templateId: "7", userId: "1" } }],
  );
});

test("category-only edit does not disable the learned template", async () => {
  const templates = createTemplateRepository();
  const state = createManageStateStore({
    stateName: "confirm_action",
    stateData: {
      action: "edit",
      transaction_id: "123",
      before: learnedParsedTransaction,
      changes: { category: "Dining" },
    },
  });
  const { service } = createService(
    [[{ id: "1", telegram_id: "976684739" }], [learnedParsedTransaction], []],
    undefined,
    undefined,
    templates.repository,
  );
  spyOnWatchdog(service);

  const result = await service.handleManagedTransaction(
    {
      telegramUserId: "976684739",
      text: "veyra_tx_manage:confirm",
      llmResult: null,
    },
    state.store,
  );

  assert.equal(result.status, "completed");
  assert.equal(
    templates.calls.some((call) => call.method === "disable"),
    false,
  );
});

test("manage delete confirm skips watchdog", async () => {
  const state = createManageStateStore({
    stateName: "confirm_action",
    stateData: { action: "delete", transaction_id: "101" },
  });
  const { service } = createService([
    [{ id: "1", telegram_id: "976684739" }],
    [manageTransaction],
    [],
  ]);
  const watchdogCalls = spyOnWatchdog(service);

  const result = await service.handleManagedTransaction(
    {
      telegramUserId: "976684739",
      text: "veyra_tx_manage:confirm",
      llmResult: null,
    },
    state.store,
  );

  assert.equal(result.status, "completed");
  assert.deepEqual(watchdogCalls, []);
});

test("pending transaction confirm triggers watchdog", async () => {
  const { service } = createService([[transaction], []]);
  const watchdogCalls = spyOnWatchdog(service);

  const result = await service.confirmTransaction({
    transactionId: "tx-1",
    userId: "user-1",
  });

  assert.equal(result.status, "confirmed");
  assert.deepEqual(watchdogCalls, ["tx-1"]);
});

test("pending transaction cancel skips watchdog", async () => {
  const { service } = createService([[transaction], []]);
  const watchdogCalls = spyOnWatchdog(service);

  const result = await service.cancelTransaction({
    transactionId: "tx-1",
    userId: "user-1",
  });

  assert.equal(result.status, "rejected");
  assert.deepEqual(watchdogCalls, []);
});

test("Save activates the validated user template after confirming the transaction", async () => {
  const templates = createTemplateRepository();
  const { calls, service } = createService(
    [[pendingAiTransaction], [], [], [], [], []],
    undefined,
    undefined,
    templates.repository,
  );

  const result = await service.confirmTransaction({
    transactionId: "123",
    userId: "1",
  });

  assert.equal(result.status, "confirmed");
  assert.equal(templates.calls[0].method, "activate");
  const activation = templates.calls[0]
    .input as ActivateEmailParserTemplateInput;
  assert.equal(activation.userId, "1");
  assert.equal(activation.senderAddress, "alerts@krom.id");
  assert.equal(
    calls.some(
      (call) =>
        /UPDATE transaction_imports/.test(call.text) &&
        call.values[0] === "confirmed",
    ),
    true,
  );
});

test("confirmed AI email learns a global alias and user category rule", async () => {
  const templates = createTemplateRepository();
  const { calls, service } = createService(
    [[pendingAiTransaction], [], [], [], [], [], []],
    undefined,
    undefined,
    templates.repository,
  );
  spyOnWatchdog(service);

  await service.confirmTransaction({ transactionId: "123", userId: "1" });

  const aliasSelect = calls.find((call) =>
    /SELECT id, canonical_name\s+FROM merchant_aliases/.test(call.text),
  );
  const aliasInsert = calls.find((call) =>
    /INSERT INTO merchant_aliases/.test(call.text),
  );
  const categoryInsert = calls.find((call) =>
    /INSERT INTO category_rules/.test(call.text),
  );
  assert.ok(aliasSelect);
  assert.doesNotMatch(aliasSelect.text, /user_id/);
  assert.deepEqual(aliasSelect.values, ["Kopi Tuku"]);
  assert.deepEqual(aliasInsert?.values, ["Kopi Tuku", "Kopi Tuku"]);
  assert.deepEqual(categoryInsert?.values, ["1", "Kopi Tuku", "Food"]);
});

test("confirmation succeeds when template activation fails", async () => {
  const templates = createTemplateRepository([], new Error("db unavailable"));
  const { service } = createService(
    [[pendingAiTransaction], [], [], [], [], []],
    undefined,
    undefined,
    templates.repository,
  );

  const result = await service.confirmTransaction({
    transactionId: "123",
    userId: "1",
  });

  assert.equal(result.status, "confirmed");
});

test("Cancel never activates a proposed template", async () => {
  const templates = createTemplateRepository();
  const { calls, service } = createService(
    [[pendingAiTransaction], [], []],
    undefined,
    undefined,
    templates.repository,
  );

  await service.cancelTransaction({ transactionId: "123", userId: "1" });

  assert.equal(
    templates.calls.some((call) => call.method === "activate"),
    false,
  );
  assert.equal(
    calls.some(
      (call) =>
        /UPDATE transaction_imports/.test(call.text) &&
        call.values[0] === "rejected",
    ),
    true,
  );
});

test("category confirmation activates the proposal exactly once", async () => {
  const templates = createTemplateRepository();
  const { service } = createService(
    [
      [pendingAiTransaction],
      [{ id: "budget-food", category: "Dining", parent_category: null }],
      [],
      [],
      [],
      [],
      [],
    ],
    undefined,
    undefined,
    templates.repository,
  );
  spyOnWatchdog(service);

  const result = await service.setPendingTransactionCategory({
    transactionId: "123",
    budgetId: "budget-food",
    userId: "1",
  });

  assert.equal(result.status, "updated");
  assert.equal(
    templates.calls.filter((call) => call.method === "activate").length,
    1,
  );
});

test("category confirmation triggers watchdog", async () => {
  const { service } = createService([
    [transaction],
    [{ id: "budget-food", category: "Food", parent_category: null }],
    [],
  ]);
  const watchdogCalls = spyOnWatchdog(service, {
    notifications: [],
    watchdog: {
      checked: true,
      hasAlert: true,
      alerts: [],
      message: {
        text: "<b>Budget warning.</b>\nFood is now 90% used.",
        parse_mode: "HTML",
        disable_web_page_preview: true,
      },
    },
  });

  const result = await service.setPendingTransactionCategory({
    transactionId: "tx-1",
    budgetId: "budget-food",
    userId: "user-1",
  });

  assert.equal(result.status, "updated");
  assert.deepEqual(watchdogCalls, ["tx-1"]);
  assert.equal(result.editMessage?.parseMode, "HTML");
});

test("budget alert and risk review can return together", async () => {
  const budgetService = {
    evaluateTransaction: async () => ({
      checked: true,
      hasAlert: true,
      alerts: [
        {
          type: "budget_90" as const,
          budgetId: "12",
          category: "Shopping",
          usedPercent: 90,
          remainingAmount: 100000,
          safeDailySpend: 10000,
          projectedCycleSpend: 1200000,
          projectedOverrun: 200000,
        },
      ],
      message: null,
    }),
  } as unknown as BudgetService;
  const riskReviews = createRiskReviewRepository({
    ...riskReview,
    id: "55",
    transactionId: "tx-1",
  });
  const { service } = createService(
    [
      [
        {
          ...transaction,
          id: "tx-1",
          user_id: "user-1",
          transaction_type: "expense",
          transaction_date: "2026-06-25",
          status: "confirmed",
        },
      ],
      [{ cycle_start_day: 25 }],
      [
        {
          category_budget_id: "12",
          category_budget_category: "Shopping",
          category_budget_amount: "100000",
          category_spend_before: "0",
          parent_budget_id: "12",
          parent_budget_category: "Shopping",
          parent_budget_amount: "200000",
          parent_spend_before: "0",
          total_budget_amount: "200000",
          total_spend_before: "0",
        },
      ],
      [{ cycle_start_day: 25 }],
      [
        {
          category_budget_id: "12",
          category_budget_category: "Shopping",
          category_budget_amount: "100000",
          category_spend_before: "0",
          parent_budget_id: "12",
          parent_budget_category: "Shopping",
          parent_budget_amount: "200000",
          parent_spend_before: "0",
          total_budget_amount: "200000",
          total_spend_before: "0",
        },
      ],
      [],
      [{ count: "0" }],
    ],
    budgetService,
    riskReviews.repository,
  );

  const result = await service.evaluateTransactionWatchdog("tx-1");

  assert.deepEqual(
    result.notifications.map((notification) => notification.type),
    ["risk_review", "budget_alert"],
  );
  assert.equal(result.notifications[0].priority, 1);
  assert.equal(result.notifications[0].review_id, 55);
  assert.equal(result.notifications[1].priority, 2);
});

test("watchdog failure does not fail transaction save", async () => {
  const budgetService = {
    evaluateTransaction: async () => {
      throw new Error("risk service unavailable");
    },
  } as unknown as BudgetService;
  const { service } = createService(
    [
      [],
      [{ id: "tx-manual" }],
      [
        {
          ...transaction,
          id: "tx-manual",
          user_id: "1",
          transaction_type: "expense",
          transaction_date: "2026-06-25",
          status: "confirmed",
        },
      ],
    ],
    budgetService,
  );

  const result = await service.handleManualTransaction({
    userId: 1,
    source: "manual",
    llmResult: {
      transaction_type: "expense",
      amount: 25000,
      merchant: "kopi tuku",
      category: "Coffee",
      confidence: 95,
    },
  });

  assert.equal(result.status, "confirmed");
  assert.deepEqual(result.notifications, []);
});
