import * as assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { join } from "node:path";
import {
  BadRequestException,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { VeyraAiService } from "../../ai/veyra-ai.service";
import { DatabaseService } from "../../database/database.service";
import { BudgetService } from "../budgets/budget.service";
import {
  EmailParserTemplateProposalDto,
  EmailReviewTransactionCandidateDto,
  EmailSourceReferenceRequestDto,
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

const watchdogN8nFixture = JSON.parse(
  readFileSync(
    join(
      process.cwd(),
      "src/veyra/transactions/test/fixtures/watchdog/n8n-mapping.json",
    ),
    "utf8",
  ),
) as {
  notifications: {
    orderedTypes: string[];
    priorities: number[];
    messages: string[];
    riskCallbackData: string[];
    riskReplyMarkup: {
      inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
    };
  };
  callbackContext: {
    telegramUserId: string;
    userId: number;
    chatId: string;
    messageId: number;
  };
  expectedTelegram: {
    method: "editMessageText";
    parse_mode: "HTML";
    reply_markup: null;
  };
  callbacks: Array<{
    action: "planned" | "necessary" | "regret" | "ignore";
    callbackData: string;
    expectedText: string;
    resolvesImmediately: boolean;
  }>;
};

function createService(
  rowsByCall: Array<unknown[] | Error> = [],
  budgetService?: BudgetService,
  riskReviewRepository?: TransactionRiskReviewRepository,
  emailParserTemplateRepository?: EmailParserTemplateRepository,
  resolvedEmailUserId: string | null = "1",
  veyraAiService?: VeyraAiService,
) {
  const calls: Array<{ text: string; values: unknown[] }> = [];
  const transactionCalls: Array<{ text: string; values: unknown[] }> = [];
  const transactionEvents: Array<"begin" | "commit" | "rollback"> = [];
  const query = async (text: string, values: unknown[] = []) => {
    if (/resolve_email_caller/.test(text)) {
      return {
        rows:
          resolvedEmailUserId === null
            ? []
            : [{ id: resolvedEmailUserId, telegram_id: values[0] }],
      };
    }
    calls.push({ text, values });
    const rows = rowsByCall.shift() ?? [];
    if (rows instanceof Error) throw rows;
    return { rows };
  };
  const database = {
    query,
    withTransaction: async (
      callback: (client: { query: typeof query }) => unknown,
    ) => {
      transactionEvents.push("begin");
      try {
        const result = await callback({
          query: async (text: string, values: unknown[] = []) => {
            transactionCalls.push({ text, values });
            return query(text, values);
          },
        });
        transactionEvents.push("commit");
        return result;
      } catch (error) {
        transactionEvents.push("rollback");
        throw error;
      }
    },
  } as unknown as DatabaseService;

  const resolvedBudgetService = budgetService ?? defaultBudgetService();
  if (!("resolveExpenseAssignment" in resolvedBudgetService)) {
    Object.assign(resolvedBudgetService, {
      resolveExpenseAssignment: async (request: { category: string }) => ({
        status: "resolved" as const,
        category: request.category,
        needsCategoryReview: false,
        pocketId: "42",
        pocketName: "Monthly Transactions",
      }),
    });
  }

  return {
    calls,
    transactionCalls,
    transactionEvents,
    service: new TransactionService(
      database,
      resolvedBudgetService,
      riskReviewRepository,
      emailParserTemplateRepository,
      veyraAiService,
    ),
  };
}

function defaultBudgetService() {
  return {
    getBudgetCategories: async () => ({ status: "ok", categories: [] }),
    resolveExpenseAssignment: async (request: { category: string }) => ({
      status: "resolved" as const,
      category: request.category,
      needsCategoryReview: false,
      pocketId: "42",
      pocketName: "Monthly Transactions",
    }),
    evaluateTransaction: async () => ({ checked: false, notifications: [] }),
  } as unknown as BudgetService;
}

function manualExpense(overrides: Record<string, unknown> = {}) {
  return {
    userId: 1,
    source: "manual",
    llmResult: {
      transaction_type: "expense",
      amount: 500_000,
      merchant: "Toy Store",
      category: "Toys",
      confidence: 80,
      missing_fields: [],
    },
    ...overrides,
  };
}

function manualIncome(overrides: Record<string, unknown> = {}) {
  return {
    userId: 1,
    source: "manual",
    llmResult: {
      transaction_type: "income",
      amount: 500_000,
      confidence: 80,
      missing_fields: [],
    },
    ...overrides,
  };
}

function createBudgetService(
  assignment: {
    status: "resolved";
    category: string;
    needsCategoryReview: boolean;
    pocketId: string;
    pocketName: string;
  } = {
    status: "resolved",
    category: "Uncategorized",
    needsCategoryReview: true,
    pocketId: "42",
    pocketName: "Monthly Transactions",
  },
) {
  return {
    resolveExpenseAssignment: async () => assignment,
  } as unknown as BudgetService;
}

function createBudgetServiceWithCalls() {
  const calls: Array<{ userId: string; pocketId?: string; category: string }> = [];
  return {
    calls,
    service: {
      resolveExpenseAssignment: async (request: {
        userId: string;
        pocketId?: string;
        category: string;
      }) => {
        calls.push(request);
        return {
          status: "resolved" as const,
          category: "Uncategorized",
          needsCategoryReview: true,
          pocketId: "42",
          pocketName: "Monthly Transactions",
        };
      },
    } as unknown as BudgetService,
  };
}

function createAwaitingPocketBudgetService() {
  return {
    resolveExpenseAssignment: async () => ({
      status: "awaiting_pocket" as const,
      category: "Uncategorized",
      needsCategoryReview: true,
      pockets: [
        { id: "42", name: "Monthly Transactions", amount: null, isDefault: false },
        { id: "43", name: "Cash", amount: null, isDefault: false },
      ],
    }),
  } as unknown as BudgetService;
}

function createTemplateRepository(
  templates: LearnedEmailTemplate[] = [],
  activateError?: Error,
  disableError?: Error,
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
      disable: async (
        templateId: string,
        userId: string,
        query?: (text: string, values?: unknown[]) => Promise<unknown>,
      ) => {
        calls.push({ method: "disable", input: { templateId, userId } });
        await query?.(
          "UPDATE email_parser_templates SET status = 'disabled' WHERE id = $1 AND user_id = $2",
          [templateId, userId],
        );
        if (disableError) throw disableError;
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
  user_id: "1",
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
  id: "101",
  user_id: "1",
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
    templateProposal: {
      ...learnedProposal,
      injectedBody: "must not persist",
      amount: {
        ...learnedProposal.amount,
        executable: "process.exit()",
      },
    } as EmailParserTemplateProposalDto,
    ...overrides,
  };
}

function boundImportRaw(email: EmailTransactionMessageDto) {
  const subject = normalizeEmailWhitespace(email.subject);
  const body = normalizeEmailWhitespace(email.emailText);

  return {
    email: {
      messageId: email.messageId,
      from: normalizeEmailWhitespace(email.from).toLowerCase(),
      authentication: email.authentication,
      binding: {
        contentHash: createHash("sha256")
          .update(JSON.stringify({ subject, body }))
          .digest("hex"),
      },
    },
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
    [
      {
        id: "import-1",
        transaction_id: null,
        status: "needs_ai",
        raw_payload: boundImportRaw(authenticatedUnknownKromEmail.email),
      },
    ],
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
    email: boundImportRaw(authenticatedUnknownKromEmail.email).email,
    parserSource: "ai",
    validatedTemplate: {
      fingerprint: learnedTemplate.fingerprint,
      proposal: learnedProposal,
    },
  },
};

test("returns Gmail message ID for an owned pending email transaction", async () => {
  const { calls, service } = createService([
    [{ id: "1", telegram_id: "976684739" }],
    [{ transaction_id: "123", source_reference: "gmail-message-id" }],
  ]);
  const request: EmailSourceReferenceRequestDto = {
    telegramUserId: "976684739",
    transactionId: 123,
  };

  const result = await service.getEmailSourceReference(request);

  assert.deepEqual(result, {
    transactionId: "123",
    messageId: "gmail-message-id",
  });
  assert.deepEqual(calls[1]?.values, ["123", "1"]);
  assert.match(calls[1]?.text ?? "", /transaction\.source = 'email'/);
  assert.match(calls[1]?.text ?? "", /transaction\.status = 'pending'/);
  assert.match(calls[1]?.text ?? "", /email_import\.source = 'email'/);
  assert.match(calls[1]?.text ?? "", /email_import\.status = 'pending'/);
  assert.match(
    calls[1]?.text ?? "",
    /email_import\.user_id = transaction\.user_id/,
  );
});

test("rejects invalid email source reference identifiers", async () => {
  const { calls, service } = createService();

  await assert.rejects(
    () =>
      service.getEmailSourceReference(
        undefined as unknown as EmailSourceReferenceRequestDto,
      ),
    (error: unknown) =>
      error instanceof BadRequestException &&
      error.message === "telegramUserId must be a positive integer",
  );
  await assert.rejects(
    () =>
      service.getEmailSourceReference({
        telegramUserId: "invalid",
        transactionId: "123",
      }),
    (error: unknown) =>
      error instanceof BadRequestException &&
      error.message === "telegramUserId must be a positive integer",
  );
  await assert.rejects(
    () =>
      service.getEmailSourceReference({
        telegramUserId: "976684739",
        transactionId: "0",
      }),
    (error: unknown) =>
      error instanceof BadRequestException &&
      error.message === "transactionId must be a positive integer",
  );
  await assert.rejects(
    () =>
      service.getEmailSourceReference({
        telegramUserId: "976684739",
        transactionId: Number.MAX_SAFE_INTEGER + 1,
      }),
    (error: unknown) =>
      error instanceof BadRequestException &&
      error.message === "transactionId must be a positive integer",
  );

  assert.equal(calls.length, 0);
});

test("hides unknown users and missing email source mappings behind one 404", async () => {
  const unknownUser = createService([[]]);

  await assert.rejects(
    () =>
      unknownUser.service.getEmailSourceReference({
        telegramUserId: "976684739",
        transactionId: "123",
      }),
    (error: unknown) =>
      error instanceof NotFoundException &&
      error.message === "email source reference was not found",
  );

  const missingMapping = createService([
    [{ id: "1", telegram_id: "976684739" }],
    [],
  ]);

  await assert.rejects(
    () =>
      missingMapping.service.getEmailSourceReference({
        telegramUserId: "976684739",
        transactionId: "123",
      }),
    (error: unknown) =>
      error instanceof NotFoundException &&
      error.message === "email source reference was not found",
  );
});

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

const pendingTemplateTransaction = {
  ...pendingAiTransaction,
  raw_payload: {
    ...pendingAiTransaction.raw_payload,
    parserSource: "review",
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
    userId: "1",
    transactionType: "expense",
    amount: "Rp50.000",
    merchant: " gopay ",
    transactionDate: "2026-06-17T10:00:00.000Z",
  });

  assert.equal(result.userId, "1");
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
    userId: "1",
    transactionType: " INCOME ",
    amount: 75000,
    merchant: "Payroll",
  });

  assert.equal(result.transactionType, "income");
});

test("normalizes income without merchant or category", async () => {
  const { calls, service } = createService();

  const result = await service.normalizeTransaction({
    userId: "1",
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
    userId: "1",
    transactionType: "cashback",
    amount: 10000,
    merchant: "Bank Promo",
  });
  const reversal = await service.normalizeTransaction({
    userId: "1",
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
    userId: "1",
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
    userId: "1",
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
    userId: "1",
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
        userId: "1",
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
        userId: "1",
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
    userId: "1",
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
  const { calls, service } = createService([[], [{ id: "10123" }]]);

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
  assert.equal(result.transactionId, "10123");
  assert.match(
    result.message,
    /Recorded: Rp25\.000 at Kopi Tuku under Coffee\./,
  );
  assert.match(calls[1].text, /INSERT INTO transactions/);
  assert.deepEqual(calls[1].values.slice(0, 12), [
    "1",
    "expense",
    25000,
    "kopi tuku",
    "kopi tuku",
    "Coffee",
    "42",
    calls[1].values[7],
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

test("saves Toys under default Monthly Transactions without Toys budget", async () => {
  const { calls, service } = createService(
    [[], [{ id: "101" }]],
    createBudgetService(),
  );

  const result = await service.handleManualTransaction(
    manualExpense({
      llmResult: {
        ...manualExpense().llmResult,
        confidence: 95,
      },
    }),
  );

  assert.equal(result.status, "confirmed");
  const insert = calls.find(({ text }) => /INSERT INTO transactions/.test(text));
  assert.match(insert?.text ?? "", /category,\s*pocket_id/);
  assert.ok(insert?.values.includes("42"));
  assert.match(
    result.confirmationPayload?.reply_markup.inline_keyboard
      .flat()
      .find((button) => button.callback_data.startsWith("change_categories:"))
      ?.text ?? "",
    /Review Category/,
  );
});

test("explicit pocket overrides default", async () => {
  const { calls: assignmentCalls, service: budgetService } =
    createBudgetServiceWithCalls();
  const { service } = createService([[], [{ id: "101" }]], budgetService);

  await service.handleManualTransaction({ ...manualExpense(), pocketId: "77" });

  assert.equal(assignmentCalls[0].pocketId, "77");
});

test("multiple pockets without default returns awaiting_pocket without INSERT", async () => {
  const { calls, service } = createService([], createAwaitingPocketBudgetService());

  const result = await service.handleManualTransaction(manualExpense());

  assert.equal(result.status, "awaiting_pocket");
  assert.equal(calls.some(({ text }) => /INSERT INTO transactions/.test(text)), false);
});

test("income keeps null category and null pocket", async () => {
  const { calls, service } = createService([[{ id: "101" }]]);

  const result = await service.handleManualTransaction(manualIncome());

  assert.equal(result.status, "pending");
  assert.equal(result.confirmationPayload?.text.includes("Pocket:"), false);
  assert.equal(calls[0].values.includes("42"), false);
});

test("extracts from text when llmResult is absent and reuses the existing save path", async () => {
  const extractionCalls: unknown[] = [];
  const categoryCalls: unknown[] = [];
  const budgetService = {
    getBudgetCategories: async (request: unknown) => {
      categoryCalls.push(request);
      return {
        status: "ok",
        categories: [{ id: "1", category: "Coffee", parent_category: "Food" }],
      };
    },
  } as unknown as BudgetService;
  const veyraAiService = {
    extractTransaction: async (request: unknown) => {
      extractionCalls.push(request);
      return {
        intent: "record_transaction" as const,
        transaction_type: "expense",
        amount: 25000,
        merchant: "kopi tuku",
        category: "Coffee",
        wallet: null,
        notes: null,
        missing_fields: [],
        confidence: 0.94,
      };
    },
  } as unknown as VeyraAiService;
  const { calls, service } = createService(
    Array.from({ length: 8 }, () => [{ id: "10123" }]),
    budgetService,
    undefined,
    undefined,
    "1",
    veyraAiService,
  );

  const result = await service.handleManualTransaction({
    telegramUserId: "976684739",
    userId: 1,
    source: "manual",
    text: " Spend 25k at Tuku ",
  });

  assert.deepEqual(categoryCalls, [{ userId: 1 }]);
  assert.deepEqual(extractionCalls, [
    { text: "Spend 25k at Tuku", allowedCategories: ["Coffee"] },
  ]);
  assert.equal(result.status, "confirmed");
  assert.equal(result.transactionId, "10123");
  assert.equal(
    result.message,
    "✅ Recorded: Rp25.000 at Kopi Tuku under Coffee.",
  );
  assert.deepEqual(result.notifications, []);
  const insert = calls.find(({ text }) => /INSERT INTO transactions/.test(text));
  assert.match(insert?.text ?? "", /INSERT INTO transactions/);
  assert.equal(insert?.values[9], "confirmed");
  assert.equal(insert?.values[10], 94);
});

test("uses caller llmResult without calling OpenAI", async () => {
  let extractionCalls = 0;
  const veyraAiService = {
    extractTransaction: async () => {
      extractionCalls += 1;
      throw new Error("OpenAI must not be called");
    },
  } as unknown as VeyraAiService;
  const { service } = createService(
    [[], [{ id: "caller-result" }]],
    undefined,
    undefined,
    undefined,
    "1",
    veyraAiService,
  );

  const result = await service.handleManualTransaction({
    userId: 1,
    source: "manual",
    text: "Spend 25k at Tuku",
    llmResult: {
      transaction_type: "expense",
      amount: 25000,
      merchant: "kopi tuku",
      category: "Coffee",
      confidence: 95,
    },
  });

  assert.equal(result.status, "confirmed");
  assert.equal(extractionCalls, 0);
});

test("rejects missing text without calling OpenAI or writing", async () => {
  let extractionCalls = 0;
  const veyraAiService = {
    extractTransaction: async () => {
      extractionCalls += 1;
      throw new Error("OpenAI must not be called");
    },
  } as unknown as VeyraAiService;
  const { calls, service } = createService(
    [],
    undefined,
    undefined,
    undefined,
    "1",
    veyraAiService,
  );

  await assert.rejects(
    () => service.handleManualTransaction({ userId: 1, source: "manual" }),
    /text is required when llmResult is absent/,
  );
  assert.equal(extractionCalls, 0);
  assert.equal(calls.length, 0);
});

test("AI extraction failure writes no transaction and preserves conversation state", async () => {
  const veyraAiService = {
    extractTransaction: async () => {
      throw new ServiceUnavailableException("AI transaction extraction failed");
    },
  } as unknown as VeyraAiService;
  const { calls, service } = createService(
    [],
    undefined,
    undefined,
    undefined,
    "1",
    veyraAiService,
  );
  const state = createStateStore();

  await assert.rejects(
    () =>
      service.handleManualTransaction(
        { userId: 1, source: "manual", text: "Spend 25k at Tuku" },
        state.store,
      ),
    /AI transaction extraction failed/,
  );
  assert.equal(calls.length, 0);
  assert.deepEqual(state.calls, []);
});

test("rejects an unknown AI intent without writing or mutating state", async () => {
  const veyraAiService = {
    extractTransaction: async () => ({
      intent: "unknown",
      transaction_type: null,
      amount: null,
      merchant: null,
      category: null,
      wallet: null,
      notes: null,
      missing_fields: ["amount"],
      confidence: 0,
    }),
  } as unknown as VeyraAiService;
  const { calls, service } = createService(
    [],
    undefined,
    undefined,
    undefined,
    "1",
    veyraAiService,
  );
  const state = createStateStore();

  await assert.rejects(
    () =>
      service.handleManualTransaction(
        { userId: 1, source: "manual", text: "hello" },
        state.store,
      ),
    BadRequestException,
  );
  assert.equal(calls.length, 0);
  assert.deepEqual(state.calls, []);
});

test("cancels and resets state for a model-produced reset intent without writing", async () => {
  const veyraAiService = {
    extractTransaction: async () => ({
      intent: "reset",
      transaction_type: null,
      amount: null,
      merchant: null,
      category: null,
      wallet: null,
      notes: null,
      missing_fields: [],
      confidence: 1,
    }),
  } as unknown as VeyraAiService;
  const { calls, service } = createService(
    [],
    undefined,
    undefined,
    undefined,
    "1",
    veyraAiService,
  );
  const state = createStateStore();

  const result = await service.handleManualTransaction(
    { userId: 1, source: "manual", text: "never mind" },
    state.store,
  );

  assert.equal(result.status, "cancelled");
  assert.equal(result.transactionId, null);
  assert.equal(calls.length, 0);
  assert.deepEqual(state.calls, [
    { method: "resetState", request: { userId: 1 } },
  ]);
});

test("deterministic reset and unsupported source never call OpenAI", async () => {
  let extractionCalls = 0;
  const veyraAiService = {
    extractTransaction: async () => {
      extractionCalls += 1;
      throw new Error("OpenAI must not be called");
    },
  } as unknown as VeyraAiService;
  const { calls, service } = createService(
    [],
    undefined,
    undefined,
    undefined,
    "1",
    veyraAiService,
  );
  const state = createStateStore();

  const reset = await service.handleManualTransaction(
    { userId: 1, source: "manual", text: "batal" },
    state.store,
  );
  const unsupported = await service.handleManualTransaction({
    userId: 1,
    source: "email",
    text: "Spend 25k at Tuku",
  });

  assert.equal(reset.status, "cancelled");
  assert.equal(unsupported.status, "unsupported_source");
  assert.equal(extractionCalls, 0);
  assert.equal(calls.length, 0);
  assert.deepEqual(state.calls, [
    { method: "resetState", request: { userId: 1 } },
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
  assert.match(
    result.confirmationPayload?.text ?? "",
    /Amount: Rp19\.828\.000/,
  );
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
  assert.equal(calls[1].values[10], 94);
  assert.equal(calls[1].values[9], "confirmed");
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
  assert.equal(calls[1].values[9], "pending");
  assert.equal(calls[1].values[10], 75);
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
    [{ id: "102" }],
    [
      {
        id: "102",
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
        id: "102",
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
  assert.deepEqual(calls[4].values, ["confirmed", "102", "1"]);
  assert.match(calls[4].text, /UPDATE transactions/);
});

test("builds confirmation payload for normal pending transaction", () => {
  const { service } = createService();

  const result = service.buildConfirmationPayload({
    pendingTransactionId: "pending-1",
    transactionId: "101",
    userId: "1",
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
      { text: "Save", callback_data: "save_transaction:101" },
      { text: "Change Category", callback_data: "change_categories:101" },
    ],
    [{ text: "Cancel", callback_data: "cancel_transaction:101" }],
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
    pocketId: null,
    pocketName: null,
    wallet: "BCA",
    notes: "QRIS payment",
  });
  assert.deepEqual(result.warnings, []);
});

test("builds readable confirmation payload without pendingTransactionId", () => {
  const { service } = createService();

  const result = service.buildConfirmationPayload({
    userId: "1",
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
    userId: "1",
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
    transactionId: "101",
    userId: "1",
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
    userId: "1",
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
    userId: "1",
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
    transactionId: "103",
    userId: "1",
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
      { text: "Save", callback_data: "save_transaction:103" },
      {
        text: "Change Category",
        callback_data: "change_categories:103",
      },
    ],
    [{ text: "Cancel", callback_data: "cancel_transaction:103" }],
  ]);
});

test("builds email confirmation payload snapshot with escaped HTML", () => {
  const { service } = createService();

  const result = service.buildConfirmationPayload({
    transactionId: "tx-email",
    userId: "1",
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
    userId: "1",
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
        id: "101",
        user_id: "1",
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
    transactionId: "101",
    userId: "1",
  });

  assert.deepEqual(result, {
    status: "confirmed",
    transactionId: "101",
    userId: "1",
    summary: {
      amount: 50000,
      merchant: "GoPay",
      category: "Transport",
      pocketId: null,
      pocketName: null,
    },
    editMessage: {
      text: "Transaction 101 confirmed: GoPay • Rp50.000",
      parseMode: null,
    },
    notifications: [],
  });
  assert.deepEqual(calls[0].values, ["101", "1"]);
  assert.match(calls[0].text, /FROM transactions/);
  assert.match(calls[1].text, /UPDATE transactions/);
  assert.match(calls[1].text, /updated_at = now\(\)/);
  assert.deepEqual(calls[1].values, ["confirmed", "101", "1"]);
});

const pendingCreditCardExpense = {
  id: "101",
  user_id: "1",
  transaction_type: "expense",
  amount: "50000",
  merchant: "Toko Buku",
  merchant_normalized: "Toko Buku",
  category: "Shopping",
  transaction_date: "2026-07-02T03:00:00.000Z",
  source: "email",
  status: "pending",
  raw_payload: { parsed: { paymentType: "Credit Card" } },
};

test("confirmed email credit-card expense adds cycle usage", async () => {
  const { service, transactionCalls } = createService([
    [pendingCreditCardExpense],
    [{ ...pendingCreditCardExpense, status: "confirmed" }],
    [{ id: "import-1" }],
    [],
  ]);

  const result = await service.confirmTransaction({
    transactionId: "101",
    userId: "1",
  });

  assert.equal(result.status, "confirmed");
  const summaryCall = transactionCalls.find(({ text }) =>
    /INSERT INTO credit_card_cycle_summaries/.test(text),
  );
  assert.ok(summaryCall);
  assert.deepEqual(summaryCall.values, [
    "1",
    "2026-07-02T03:00:00.000Z",
    50000,
    50000,
  ]);
  assert.match(summaryCall.text, /ON CONFLICT \(user_id, cycle_start\)/);
});

test("confirmed email credit-card reversal subtracts cycle usage", async () => {
  const pendingReversal = {
    ...pendingCreditCardExpense,
    id: "102",
    transaction_type: "reversal",
    transaction_date: "2026-07-12T03:00:00.000Z",
  };
  const { service, transactionCalls } = createService([
    [pendingReversal],
    [{ ...pendingReversal, status: "confirmed" }],
    [{ id: "import-1" }],
    [],
  ]);

  const result = await service.confirmTransaction({
    transactionId: "102",
    userId: "1",
  });

  assert.equal(result.status, "confirmed");
  const summaryCall = transactionCalls.find(({ text }) =>
    /INSERT INTO credit_card_cycle_summaries/.test(text),
  );
  assert.ok(summaryCall);
  assert.deepEqual(summaryCall.values, [
    "1",
    "2026-07-12T03:00:00.000Z",
    0,
    -50000,
  ]);
  assert.match(summaryCall.text, /GREATEST\(\s*0,/);
});

test("confirmed non-card email expense does not change card usage", async () => {
  const pendingExpense = {
    ...pendingCreditCardExpense,
    id: "103",
    merchant: "Kopi Tuku",
    merchant_normalized: "Kopi Tuku",
    category: "Food",
    transaction_date: "2026-07-13T03:00:00.000Z",
    raw_payload: { parsed: { paymentType: "QRIS" } },
  };
  const { service, transactionCalls } = createService([
    [pendingExpense],
    [{ ...pendingExpense, status: "confirmed" }],
    [{ id: "import-1" }],
    [],
  ]);

  const result = await service.confirmTransaction({
    transactionId: "103",
    userId: "1",
  });

  assert.equal(result.status, "confirmed");
  assert.equal(
    transactionCalls.some(({ text }) =>
      /INSERT INTO credit_card_cycle_summaries/.test(text),
    ),
    false,
  );
});

test("category confirmation adds email credit-card expense cycle usage", async () => {
  const pendingExpense = {
    ...pendingCreditCardExpense,
    id: "123",
    amount: "75000",
    category: "Other",
    transaction_date: "2026-07-03T03:00:00.000Z",
    raw_payload: { parsed: { paymentType: " credit card " } },
  };
  const { service, transactionCalls } = createService([
    [pendingExpense],
    [{ id: "10", category: "Shopping", parent_category: null }],
    [{ ...pendingExpense, category: "Shopping", status: "confirmed" }],
    [{ id: "import-1" }],
    [],
  ]);

  const result = await service.handleTransactionCallback({
    telegramUserId: "976684739",
    userId: 1,
    callbackData: "catid:10:123",
  });

  assert.equal(result.status, "ok");
  const summaryCall = transactionCalls.find(({ text }) =>
    /INSERT INTO credit_card_cycle_summaries/.test(text),
  );
  assert.ok(summaryCall);
  assert.deepEqual(summaryCall.values, [
    "1",
    "2026-07-03T03:00:00.000Z",
    75000,
    75000,
  ]);
});

test("rejects unresolved deterministic email confirmation", async () => {
  for (const transaction of [
    {
      merchant: "Unknown",
      merchant_normalized: "Unknown",
      category: "Food",
    },
    {
      merchant: "Kopi Tuku",
      merchant_normalized: "Kopi Tuku",
      category: "Uncategorized",
    },
  ]) {
    const { calls, service, transactionEvents } = createService([
      [
        {
          id: "101",
          user_id: "1",
          transaction_type: "expense",
          amount: "50000",
          source: "email",
          status: "pending",
          ...transaction,
        },
      ],
      [
        {
          id: "101",
          user_id: "1",
          transaction_type: "expense",
          amount: "50000",
          source: "email",
          status: "confirmed",
          ...transaction,
        },
      ],
    ]);

    await assert.rejects(
      () =>
        service.confirmTransaction({
          transactionId: "101",
          userId: "1",
        }),
      /must be (corrected|selected) before confirmation/,
    );
    assert.equal(
      calls.some((call) => /UPDATE transaction_imports/.test(call.text)),
      false,
    );
    assert.deepEqual(transactionEvents, ["begin", "rollback"]);
  }
});

test("allows income email confirmation without merchant or category", async () => {
  const pendingIncome = {
    id: "101",
    user_id: "1",
    transaction_type: "income",
    amount: "50000",
    merchant: null,
    merchant_normalized: null,
    category: null,
    source: "email",
    status: "pending",
    raw_payload: {},
  };
  const { service } = createService([
    [pendingIncome],
    [{ ...pendingIncome, status: "confirmed" }],
    [{ id: "import-1" }],
  ]);

  const result = await service.confirmTransaction({
    transactionId: "101",
    userId: "1",
  });

  assert.equal(result.status, "confirmed");
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
          id: "101",
          user_id: "1",
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
          id: "101",
          user_id: "1",
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
    transactionId: "101",
    userId: "1",
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
        id: "101",
        user_id: "1",
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
    transactionId: "101",
    userId: "1",
  });

  assert.equal(result.status, "rejected");
  assert.deepEqual(result.summary, {
    amount: 50000,
    merchant: "GoPay",
    category: "Transport",
    pocketId: null,
    pocketName: null,
  });
  assert.deepEqual(result.editMessage, {
    text: "Transaction 101 cancelled.",
    parseMode: null,
  });
  assert.match(calls[1].text, /UPDATE transactions/);
  assert.deepEqual(calls[1].values, ["rejected", "101", "1"]);
});

test("returns already_confirmed without updating transaction row", async () => {
  const { calls, service } = createService([
    [
      {
        id: "101",
        user_id: "1",
        amount: "50000",
        merchant: "gopay",
        merchant_normalized: "GoPay",
        category: "Transport",
        status: "confirmed",
      },
    ],
  ]);

  const result = await service.confirmTransaction({
    transactionId: "101",
    userId: "1",
  });

  assert.equal(result.status, "already_confirmed");
  assert.equal(calls.length, 1);
});

test("returns already_rejected without updating transaction row", async () => {
  const { calls, service } = createService([
    [
      {
        id: "101",
        user_id: "1",
        amount: "50000",
        merchant: "gopay",
        merchant_normalized: "GoPay",
        category: "Transport",
        status: "rejected",
      },
    ],
  ]);

  const result = await service.cancelTransaction({
    transactionId: "101",
    userId: "1",
  });

  assert.equal(result.status, "already_rejected");
  assert.equal(calls.length, 1);
});

test("returns not_found when transaction row does not exist", async () => {
  const { calls, service } = createService([[]]);

  const result = await service.confirmTransaction({
    transactionId: "999",
    userId: "1",
  });

  assert.deepEqual(result, {
    status: "not_found",
    transactionId: "999",
    userId: "1",
    summary: null,
    editMessage: null,
  });
  assert.equal(calls.length, 1);
});

test("returns not_found for transaction owned by a different user", async () => {
  const { calls, service } = createService([[]]);

  const result = await service.confirmTransaction({
    transactionId: "101",
    userId: "2",
  });

  assert.deepEqual(result, {
    status: "not_found",
    transactionId: "101",
    userId: "2",
    summary: null,
    editMessage: null,
  });
  assert.deepEqual(calls[0].values, ["101", "2"]);
  assert.match(calls[0].text, /AND user_id = \$2/);
  assert.doesNotMatch(calls[0].text, /::text/);
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
    transactionId: "101",
    userId: "1",
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
    userId: "1",
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
    userId: "1",
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
        userId: "1",
        category: "Travel",
      }),
    BadRequestException,
  );
});

test("sets pending transaction category and returns confirmation payload", async () => {
  const { calls, service } = createService([[pendingTransaction], []]);

  const result = await service.setPendingTransactionCategory({
    pendingTransactionId: "pending-1",
    userId: "1",
    category: "Food",
  });

  assert.equal(result.status, "updated");
  assert.equal(result.confirmationPayload?.summary.category, "Food");
  assert.match(result.confirmationPayload?.text ?? "", /Category: Food/);
  assert.deepEqual(calls[1].values, ["Food", "pending-1", "1"]);
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
    transactionId: "101",
    userId: "1",
  });

  const buttons = result.replyMarkup?.inline_keyboard.flat() ?? [];

  assert.deepEqual(
    buttons.map((button) => button.callback_data),
    [
      "catid:budget-food:101",
      "catid:budget-transport:101",
      "catid:budget-groceries:101",
      "catid:budget-bills:101",
      "catid:budget-health:101",
      "catid:budget-shopping:101",
      "catid:budget-entertainment:101",
      "catid:budget-transfer:101",
      "catid:budget-other:101",
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
    transactionId: "101",
    userId: "1",
  });

  const buttons = result.replyMarkup?.inline_keyboard.flat() ?? [];

  assert.deepEqual(
    buttons.map((button) => button.callback_data),
    ["catid:budget-dining:101", "catid:budget-meds:101"],
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
    transactionId: "101",
    userId: "1",
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
    transactionId: "101",
    budgetId: "budget-other-user",
    userId: "1",
  });

  assert.equal(result.status, "unauthorized_budget");
  assert.equal(result.transactionId, "101");
  assert.equal(result.editMessage, null);
});

test("sets transaction category and confirms on production category selection", async () => {
  const { calls, service } = createService([
    [transaction],
    [{ id: "budget-food", category: "Food", parent_category: null }],
    [],
  ]);

  const result = await service.setPendingTransactionCategory({
    transactionId: "101",
    budgetId: "budget-food",
    userId: "1",
  });

  assert.equal(result.status, "updated");
  assert.equal(result.transactionId, "101");
  assert.equal(result.summary?.category, "Food");
  assert.equal(
    result.editMessage?.text,
    "Transaction 101 confirmed: GoPay • Rp50.000",
  );
  assert.deepEqual(calls[2].values, ["Food", "101", "1"]);
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

test("handles save_transaction callback with risk-review keyboard", async () => {
  const { service } = createService([
    [{ ...transaction, id: "123", user_id: "1" }],
    [],
  ]);
  const riskReplyMarkup = watchdogN8nFixture.notifications.riskReplyMarkup;

  spyOnWatchdog(service, {
    notifications: [
      {
        type: "risk_review",
        priority: 1,
        severity: "high",
        review_id: 55,
        message: watchdogN8nFixture.notifications.messages[0],
        reply_markup: riskReplyMarkup,
      },
    ],
  });

  const result = await service.handleTransactionCallback({
    telegramUserId: "976684739",
    userId: 1,
    callbackData: "save_transaction:123",
    chatId: "chat-1",
    messageId: 42,
  });

  assert.equal(result.status, "ok");
  assert.equal(result.action, "save_transaction");
  assert.match(result.telegram.text, /Large transaction detected/);
  assert.deepEqual(result.telegram.reply_markup, riskReplyMarkup);
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
  assert.equal(
    result.telegram.text,
    "Transaction 123 confirmed: GoPay • Rp50.000",
  );
  assert.equal(result.telegram.reply_markup, null);
  assert.deepEqual(calls[2].values, ["Food", "123", "1"]);
});

test("handles catid callback with risk-review keyboard", async () => {
  const { service } = createService([
    [{ ...transaction, id: "123", user_id: "1" }],
    [{ id: "10", category: "Food", parent_category: null }],
    [],
  ]);
  const riskReplyMarkup = watchdogN8nFixture.notifications.riskReplyMarkup;

  spyOnWatchdog(service, {
    notifications: [
      {
        type: "risk_review",
        priority: 1,
        severity: "high",
        review_id: 55,
        message: watchdogN8nFixture.notifications.messages[0],
        reply_markup: riskReplyMarkup,
      },
    ],
  });

  const result = await service.handleTransactionCallback({
    telegramUserId: "976684739",
    userId: 1,
    callbackData: "catid:10:123",
    chatId: "chat-1",
    messageId: 42,
  });

  assert.equal(result.status, "ok");
  assert.equal(result.action, "catid");
  assert.match(result.telegram.text, /Large transaction detected/);
  assert.deepEqual(result.telegram.reply_markup, riskReplyMarkup);
});

test("handles immediate risk callbacks from the n8n fixture", async () => {
  const riskReviews = createRiskReviewRepository();
  const { service } = createService([], undefined, riskReviews.repository);
  const fixtures = watchdogN8nFixture.callbacks.filter(
    ({ resolvesImmediately }) => resolvesImmediately,
  );

  for (const fixture of fixtures) {
    const result = await service.handleTransactionCallback({
      ...watchdogN8nFixture.callbackContext,
      callbackData: fixture.callbackData,
    });

    assert.equal(result.status, "ok");
    assert.equal(result.action, "veyra_risk");
    assert.equal(result.transactionId, 123);
    assert.equal(result.telegram.text, fixture.expectedText);
    assert.equal(
      result.telegram.method,
      watchdogN8nFixture.expectedTelegram.method,
    );
    assert.equal(
      result.telegram.chat_id,
      watchdogN8nFixture.callbackContext.chatId,
    );
    assert.equal(
      result.telegram.message_id,
      watchdogN8nFixture.callbackContext.messageId,
    );
    assert.equal(
      result.telegram.parse_mode,
      watchdogN8nFixture.expectedTelegram.parse_mode,
    );
    assert.equal(
      result.telegram.reply_markup,
      watchdogN8nFixture.expectedTelegram.reply_markup,
    );
  }

  assert.deepEqual(
    riskReviews.calls.filter((call) => call.method === "resolve"),
    fixtures.map(({ action }) => ({
      method: "resolve",
      args: [7, 1, action, "resolved", undefined],
    })),
  );
});

test("regret callback starts note collection without resolving review", async () => {
  const riskReviews = createRiskReviewRepository();
  const state = createManageStateStore();
  const { service } = createService([], undefined, riskReviews.repository);
  const fixture = watchdogN8nFixture.callbacks.find(
    ({ resolvesImmediately }) => !resolvesImmediately,
  )!;

  assert.equal(fixture.action, "regret");
  assert.equal(fixture.resolvesImmediately, false);

  const startedAt = Date.now();
  const result = await service.handleTransactionCallback(
    {
      ...watchdogN8nFixture.callbackContext,
      callbackData: fixture.callbackData,
    },
    state.store,
  );

  assert.equal(result.status, "ok");
  assert.equal(result.action, "veyra_risk");
  assert.equal(result.transactionId, 123);
  assert.equal(result.telegram.text, fixture.expectedText);
  assert.equal(
    result.telegram.method,
    watchdogN8nFixture.expectedTelegram.method,
  );
  assert.equal(
    result.telegram.chat_id,
    watchdogN8nFixture.callbackContext.chatId,
  );
  assert.equal(
    result.telegram.message_id,
    watchdogN8nFixture.callbackContext.messageId,
  );
  assert.equal(
    result.telegram.parse_mode,
    watchdogN8nFixture.expectedTelegram.parse_mode,
  );
  assert.equal(
    result.telegram.reply_markup,
    watchdogN8nFixture.expectedTelegram.reply_markup,
  );
  assert.equal(state.state.stateName, "veyra_regret_note");
  assert.deepEqual(state.state.stateData, {
    review_id: "7",
    transaction_id: "123",
  });
  assert.ok(state.state.expiresAt);
  assert.ok(
    new Date(state.state.expiresAt).getTime() >= startedAt + 15 * 60 * 1000,
  );
  assert.ok(
    new Date(state.state.expiresAt).getTime() <= Date.now() + 15 * 60 * 1000,
  );
  assert.equal(
    riskReviews.calls.some((call) => call.method === "resolve"),
    false,
  );
});

test("regret callback fails safely when note state is unavailable", async () => {
  const riskReviews = createRiskReviewRepository();
  const { service } = createService([], undefined, riskReviews.repository);

  const result = await service.handleTransactionCallback({
    telegramUserId: "976684739",
    userId: 1,
    callbackData: "veyra_risk:7:regret",
  });

  assert.equal(result.status, "error");
  assert.equal(
    result.telegram.text,
    "Unable to collect a regret note right now.",
  );
  assert.equal(
    riskReviews.calls.some((call) => call.method === "resolve"),
    false,
  );
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
  assert.equal(
    result.telegram.text,
    "This transaction review was already answered.",
  );
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

test("expired regret note state does not update transaction", async () => {
  const riskReviews = createRiskReviewRepository();
  const state = createManageStateStore({
    stateName: "veyra_regret_note",
    stateData: { review_id: "7", transaction_id: "123" },
    expiresAt: "2000-01-01T00:00:00.000Z",
  });
  const { calls, service } = createService(
    [],
    undefined,
    riskReviews.repository,
  );

  const result = await service.handleManualTransaction(
    { userId: 1, source: "manual", text: "Late note" },
    state.store,
  );

  assert.equal(result.status, "cancelled");
  assert.equal(result.message, "Regret review expired.");
  assert.equal(calls.length, 0);
  assert.equal(riskReviews.calls.length, 0);
  assert.equal(state.state.stateName, "idle");
});

test("resolved regret review state does not update transaction", async () => {
  const riskReviews = createRiskReviewRepository({
    ...riskReview,
    status: "resolved" as const,
    userResponse: "planned",
  });
  const state = createManageStateStore({
    stateName: "veyra_regret_note",
    stateData: { review_id: "7", transaction_id: "123" },
    expiresAt: "2099-01-01T00:00:00.000Z",
  });
  const { calls, service } = createService(
    [],
    undefined,
    riskReviews.repository,
  );

  const result = await service.handleManualTransaction(
    { userId: 1, source: "manual", text: "Late note" },
    state.store,
  );

  assert.equal(result.status, "cancelled");
  assert.equal(result.message, "Regret review expired.");
  assert.equal(calls.length, 0);
  assert.deepEqual(riskReviews.calls, [{ method: "findById", args: ["7", 1] }]);
  assert.equal(state.state.stateName, "idle");
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
    userId: "1",
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
    [
      {
        id: "import-1",
        transaction_id: null,
        status: "needs_ai",
        raw_payload: boundImportRaw(authenticatedUnknownKromEmail.email),
      },
    ],
    [{ id: "123" }],
    [{ id: "import-1" }],
  ]);

  const result = await service.resolveEmailTransactionReview({
    telegramUserId: "976684739",
    reviewToken: authenticatedUnknownKromEmail.email.messageId,
    email: authenticatedUnknownKromEmail.email,
    transactionCandidate: aiCandidate,
    resolution: { category: "Food", confidence: 98, resolver: "llm" },
    templateProposal: learnedProposal,
  });

  assert.equal(result.status, "pending");
  assert.equal(result.transaction?.status, "pending");
  assert.match(calls[2].text, /FOR UPDATE/);
  assert.match(
    calls[2].text,
    /status IN \('needs_ai', 'needs_review'\).*status = 'pending'.*transaction_id IS NOT NULL/s,
  );
  assert.equal(calls[3].values[8], "pending");
  const rawPayload = calls[3].values[10] as Record<string, unknown>;
  assert.equal(rawPayload.parserSource, "ai");
  assert.equal("emailText" in rawPayload, false);
  assert.equal("emailHtml" in rawPayload, false);
  assert.deepEqual(rawPayload.email, {
    ...boundImportRaw(authenticatedUnknownKromEmail.email).email,
  });
  const validatedTemplate = rawPayload.validatedTemplate as {
    proposal: EmailParserTemplateProposalDto;
  };
  assert.ok(validatedTemplate);
  assert.equal("injectedBody" in validatedTemplate.proposal, false);
  assert.equal(
    "executable" in (validatedTemplate.proposal.amount as unknown as object),
    false,
  );
  assert.match(calls[4].text, /UPDATE transaction_imports/);
  assert.deepEqual(calls[4].values, ["123", rawPayload, "import-1"]);
  assert.ok(
    result.replyMarkup?.inline_keyboard
      .flat()
      .some((button) => button.callback_data.startsWith("save_transaction:")),
  );
});

test("does not persist or return adaptive AI descriptions", async () => {
  const privateDescription =
    "email body: card=4111111111111111 secret=description-token";
  const { calls, service } = createService([
    [{ id: "1", telegram_id: "976684739" }],
    [{ category: "Food" }],
    [{ id: "import-1", transaction_id: null, status: "needs_ai" }],
    [{ id: "123" }],
    [{ id: "import-1" }],
  ]);

  const result = await service.resolveEmailTransactionReview(
    validAiReviewRequest({
      transactionCandidate: {
        ...aiCandidate,
        description: privateDescription,
      },
    }),
  );

  assert.equal(result.status, "pending");
  assert.equal(
    calls.some((call) =>
      JSON.stringify(call.values).includes(privateDescription),
    ),
    false,
  );
  assert.equal(JSON.stringify(result).includes(privateDescription), false);
});

test("preserves the exact legacy candidate-only review contract without learning", async () => {
  const legacyRequest = {
    telegramUserId: "976684739",
    transactionCandidate: aiCandidate,
    resolution: { category: "Food", confidence: 98, resolver: "llm" },
  } as unknown as EmailTransactionResolveReviewRequestDto;
  const resolved = createService([
    [
      {
        id: "1",
        telegram_id: "976684739",
        timezone: "Asia/Jakarta",
      },
    ],
    [{ category: "Food" }],
    [{ id: "123" }],
  ]);

  const result =
    await resolved.service.resolveEmailTransactionReview(legacyRequest);

  assert.equal(result.status, "pending");
  assert.equal(result.transaction?.id, "123");
  assert.equal(
    resolved.calls.some((call) => /transaction_imports/.test(call.text)),
    false,
  );
  const insert = resolved.calls.find((call) =>
    /INSERT INTO transactions/.test(call.text),
  );
  assert.ok(insert);
  const rawPayload = insert.values.at(-1) as Record<string, unknown>;
  assert.equal(rawPayload.parserSource, undefined);
  assert.equal(rawPayload.validatedTemplate, undefined);
  assert.equal(rawPayload.email, undefined);

  const legacyPending = {
    ...pendingAiTransaction,
    raw_payload: rawPayload,
  };
  const templates = createTemplateRepository();
  const confirmation = createService(
    [[legacyPending], [{ ...legacyPending, status: "confirmed" }], []],
    undefined,
    undefined,
    templates.repository,
  );
  spyOnWatchdog(confirmation.service);

  const confirmed = await confirmation.service.confirmTransaction({
    transactionId: "123",
    userId: "1",
  });

  assert.equal(confirmed.status, "confirmed");
  assert.equal(
    templates.calls.some((call) => call.method === "activate"),
    false,
  );
});

test("legacy compatibility does not admit adaptive requests without email identity", async () => {
  for (const adaptiveFields of [
    { templateProposal: learnedProposal },
    { transactionId: "123" },
    { aiError: "model unavailable" },
    { isTransaction: false },
    { futureMode: "legacy" },
  ]) {
    const request = {
      telegramUserId: "976684739",
      transactionCandidate: aiCandidate,
      resolution: { category: "Food", confidence: 98, resolver: "llm" },
      ...adaptiveFields,
    } as unknown as EmailTransactionResolveReviewRequestDto;
    const { calls, service } = createService([
      [{ id: "1", telegram_id: "976684739" }],
    ]);

    await assert.rejects(
      () => service.resolveEmailTransactionReview(request),
      /email is required/,
    );
    assert.equal(
      calls.some((call) => /INSERT|UPDATE/.test(call.text)),
      false,
    );
  }
});

test("whitelists runtime email authentication before transaction and import persistence", async () => {
  const injectedEmail = {
    ...authenticatedUnknownKromEmail.email,
    rawHeaders: { received: "must not persist" },
    body: "must not persist",
    authentication: {
      dkim: " PASS ",
      spf: 123,
      dmarc: "fail",
      domain: " KROM.ID. ",
      emailText: "must not persist",
      rawHeaders: { authenticationResults: "must not persist" },
      body: "<html>must not persist</html>",
    },
  } as unknown as EmailTransactionMessageDto;
  const { calls, service } = createService([
    [{ id: "1", telegram_id: "976684739" }],
    [{ category: "Food" }],
    [{ id: "import-1", transaction_id: null, status: "needs_ai" }],
    [{ id: "123" }],
    [{ id: "import-1" }],
  ]);

  await service.resolveEmailTransactionReview(
    validAiReviewRequest({
      email: injectedEmail,
      templateProposal: undefined,
    }),
  );

  const transactionInsert = calls.find((call) =>
    /INSERT INTO transactions/.test(call.text),
  );
  const importUpdate = calls.find(
    (call) =>
      /UPDATE transaction_imports/.test(call.text) &&
      /raw_payload = \$2/.test(call.text),
  );
  const transactionPayload = transactionInsert?.values[10] as Record<
    string,
    unknown
  >;
  const importPayload = importUpdate?.values[1] as Record<string, unknown>;
  const expectedAuthentication = {
    dkim: "pass",
    spf: "unknown",
    dmarc: "fail",
    domain: "krom.id",
  };
  assert.deepEqual(
    (transactionPayload.email as Record<string, unknown>).authentication,
    expectedAuthentication,
  );
  assert.deepEqual(importPayload, transactionPayload);
  assert.doesNotMatch(
    JSON.stringify([transactionPayload, importPayload]),
    /emailText|rawHeaders|must not persist|<html>/,
  );
});

test("drops an invalid or oversized authentication domain", async () => {
  for (const domain of ["not a domain", "a".repeat(254)]) {
    const email = {
      ...authenticatedUnknownKromEmail.email,
      authentication: {
        dkim: "pass" as const,
        spf: "pass" as const,
        dmarc: "pass" as const,
        domain,
      },
    };
    const { calls, service } = createService([
      [{ id: "1", telegram_id: "976684739" }],
      [{ category: "Food" }],
      [{ id: "import-1", transaction_id: null, status: "needs_ai" }],
      [{ id: "123" }],
      [{ id: "import-1" }],
    ]);

    await service.resolveEmailTransactionReview(
      validAiReviewRequest({
        email,
        templateProposal: undefined,
      }),
    );

    const insert = calls.find((call) =>
      /INSERT INTO transactions/.test(call.text),
    );
    const rawPayload = insert?.values[10] as Record<string, unknown>;
    const authentication = (rawPayload.email as Record<string, unknown>)
      .authentication as Record<string, unknown>;
    assert.equal(authentication.domain, undefined);
    assert.deepEqual(Object.keys(authentication).sort(), [
      "dkim",
      "dmarc",
      "spf",
    ]);
  }
});

test("rejects unresolved expense merchants before initial or correction persistence", async () => {
  for (const candidate of [
    { ...aiCandidate, merchant: undefined, merchantNormalized: undefined },
    { ...aiCandidate, merchant: " ", merchantNormalized: " " },
    {
      ...aiCandidate,
      merchant: "Unknown",
      merchantNormalized: "Unknown",
    },
  ]) {
    for (const request of [
      validAiReviewRequest({ transactionCandidate: candidate }),
      validAiReviewRequest({
        transactionId: "123",
        transactionCandidate: candidate,
      }),
    ]) {
      const { calls, service } = createService([
        [{ id: "1", telegram_id: "976684739" }],
      ]);

      await assert.rejects(
        () => service.resolveEmailTransactionReview(request),
        /merchant is required for expense/,
      );
      assert.equal(
        calls.some((call) => /INSERT|UPDATE transactions/.test(call.text)),
        false,
      );
      assert.equal(
        calls.some((call) => /FROM transactions/.test(call.text)),
        false,
      );
    }
  }
});

test("preserves missing merchant behavior for a non-expense AI candidate", async () => {
  const { service } = createService([
    [{ id: "1", telegram_id: "976684739" }],
    [{ category: "Salary" }],
    [{ id: "import-1", transaction_id: null, status: "needs_ai" }],
    [{ id: "123" }],
    [{ id: "import-1" }],
  ]);

  const result = await service.resolveEmailTransactionReview(
    validAiReviewRequest({
      transactionCandidate: {
        ...aiCandidate,
        transactionType: "income",
        merchant: undefined,
        merchantNormalized: undefined,
      },
      resolution: { category: "Salary", confidence: 98 },
      templateProposal: undefined,
    }),
  );

  assert.equal(result.status, "pending");
  assert.equal(result.transaction?.merchant, "Unknown");
  assert.ok(
    result.replyMarkup?.inline_keyboard
      .flat()
      .some((button) => button.callback_data.startsWith("save_transaction:")),
  );
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
    [],
    [{ id: "1", telegram_id: "976684739" }],
    [{ category: "Food" }],
    [
      {
        id: "import-1",
        transaction_id: "123",
        status: "pending",
        raw_payload: boundImportRaw(authenticatedUnknownKromEmail.email),
      },
    ],
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
  assert.equal(calls.filter((call) => /FOR UPDATE/.test(call.text)).length, 2);
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
  const privateDescription = "email body: account=998877 correction-secret";
  const { calls, service } = createService([
    [{ id: "1", telegram_id: "976684739" }],
    [{ id: "123", user_id: "1", source: "email", status: "pending" }],
    [{ category: "Food" }],
    [{ id: "import-1", transaction_id: "123", status: "pending" }],
    [{ id: "123" }],
    [],
  ]);

  const result = await service.resolveEmailTransactionReview({
    telegramUserId: "976684739",
    reviewToken: correctionEmail.messageId,
    transactionId: "123",
    email: correctionEmail,
    transactionCandidate: {
      ...aiCandidate,
      amount: 30000,
      description: privateDescription,
    },
    resolution: { category: "Food", confidence: 98, resolver: "llm" },
    templateProposal: correctedKromProposal,
  });

  assert.equal(result.transaction?.id, "123");
  const update = calls.find((call) =>
    /UPDATE transactions AS transaction/.test(call.text),
  );
  assert.ok(update);
  assert.match(update.text, /transaction\.status = 'pending'/);
  assert.match(update.text, /transaction\.source = 'email'/);
  assert.equal(update.values[1], 30000);
  assert.equal(update.values[9], "123");
  assert.equal(
    JSON.stringify(update.values).includes(privateDescription),
    false,
  );
  assert.equal(JSON.stringify(result).includes(privateDescription), false);
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

test("does not persist or return caller text from an initial AI failure", async () => {
  const privateAiError =
    "model saw email body: card 4111 1111 1111 1111 secret-token";
  const { calls, service } = createService([
    [{ id: "1", telegram_id: "976684739" }],
    [{ id: "import-1" }],
    [],
  ]);

  const result = await service.resolveEmailTransactionReview({
    telegramUserId: "976684739",
    reviewToken: "gmail-learned-1",
    email: authenticatedUnknownKromEmail.email,
    aiError: privateAiError,
  });

  assert.equal(result.status, "needs_review");
  assert.equal(result.reason, "ai_failed");
  assert.equal(result.message, "AI processing failed");
  assert.match(calls[1].text, /UPDATE transaction_imports/);
  assert.match(calls[2].text, /UPDATE email_parse_attempts/);
  assert.deepEqual(calls[1].values, [
    "1",
    "gmail-learned-1",
    "AI processing failed",
  ]);
  assert.deepEqual(calls[2].values, calls[1].values);
  assert.doesNotMatch(JSON.stringify(result), /4111|secret-token/);
  assert.doesNotMatch(JSON.stringify(calls[1].values), /4111|secret-token/);
  assert.doesNotMatch(JSON.stringify(calls[2].values), /4111|secret-token/);
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
  const insert = calls.find((call) =>
    /INSERT INTO transactions/.test(call.text),
  );
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
    reviewToken: authenticatedUnknownKromEmail.email.messageId,
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
    reviewToken: authenticatedUnknownKromEmail.email.messageId,
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
    reviewToken: authenticatedUnknownKromEmail.email.messageId,
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
    reviewToken: authenticatedUnknownKromEmail.email.messageId,
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
  const privateDescription = "email body: user-not-found-secret";

  const result = await service.resolveEmailTransactionReview({
    telegramUserId: "976684739",
    reviewToken: authenticatedUnknownKromEmail.email.messageId,
    email: authenticatedUnknownKromEmail.email,
    transactionCandidate: {
      source: "email",
      transactionType: "expense",
      amount: 25000,
      merchant: "TUKU",
      description: privateDescription,
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
  assert.equal(result.transactionCandidate, undefined);
  assert.equal(JSON.stringify(result).includes(privateDescription), false);
  assert.match(calls[0].text, /FROM telegram_users/);
  assert.equal(calls.length, 1);
});

test("preserves legacy user-not-found response fields", async () => {
  const { service } = createService([[]]);
  const legacyRequest = {
    telegramUserId: "976684739",
    transactionCandidate: {
      ...aiCandidate,
      description: "legacy description",
    },
    resolution: { category: "Food", confidence: 98 },
  };

  const result = await service.resolveEmailTransactionReview(legacyRequest);

  assert.equal(result.reason, "user_not_found");
  assert.equal(
    result.transactionCandidate?.description,
    legacyRequest.transactionCandidate.description,
  );
  assert.deepEqual(result.resolution, legacyRequest.resolution);
});

test("rejects invalid email review source", async () => {
  const { service } = createService([[{ id: "1", telegram_id: "976684739" }]]);

  await assert.rejects(
    () =>
      service.resolveEmailTransactionReview({
        telegramUserId: "976684739",
        reviewToken: authenticatedUnknownKromEmail.email.messageId,
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
        reviewToken: authenticatedUnknownKromEmail.email.messageId,
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
      [{ id: "101" }],
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
      [{ id: "101" }],
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
  assert.equal(result.transaction?.id, "101");
});

test("keeps an arbitrary sender outside the AI fallback", async () => {
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

  assert.equal(result.status, "unsupported_provider");
  assert.equal(result.aiRequest, undefined);
});

test("stores only safe binding metadata for a trusted subject-led AI handoff", async () => {
  const templates = createTemplateRepository([]);
  const request: EmailTransactionHandleRequestDto = {
    ...authenticatedUnknownKromEmail,
    email: {
      ...authenticatedUnknownKromEmail.email,
      messageId: "gmail-subject-led",
      subject: "Transaksi berhasil",
      emailText: "Rp25.000",
    },
  };
  const { calls, service } = createService(
    [[], [{ id: "import-subject-led" }], []],
    undefined,
    undefined,
    templates.repository,
  );

  const result = await service.handleEmailTransaction(request);

  assert.equal(result.status, "needs_ai");
  const rawPayload = calls.find((call) =>
    /INSERT INTO transaction_imports/.test(call.text),
  )?.values[3] as Record<string, unknown>;
  assert.deepEqual(rawPayload.email, boundImportRaw(request.email).email);
  assert.equal(
    JSON.stringify(rawPayload).includes(request.email.subject),
    false,
  );
  assert.equal(
    JSON.stringify(rawPayload).includes(request.email.emailText),
    false,
  );
});

test("does not auto-save a learned result without aligned sender authentication", async () => {
  const templates = createTemplateRepository([learnedTemplate]);
  const { calls, service } = createService(
    [[], [{ id: "import-1" }], [{ id: "124" }], [{ id: "import-1" }], []],
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
  assert.equal(result.transaction?.id, "124");
  assert.equal(result.transaction?.status, "pending");
  const reviewResult = result as typeof result & {
    actions?: { confirm: { transactionId?: string } };
    replyMarkup?: unknown;
  };
  assert.equal(reviewResult.actions?.confirm.transactionId, "124");
  assert.ok(reviewResult.replyMarkup);
  assert.match(calls[1].text, /INSERT INTO transaction_imports/);
  assert.match(calls[2].text, /INSERT INTO transactions/);
  assert.match(calls[3].text, /UPDATE transaction_imports/);
});

test("deterministic insert-race loser resumes the winning pending review", async () => {
  const templates = createTemplateRepository([learnedTemplate]);
  const deterministicPending = {
    ...pendingAiTransaction,
    id: "124",
    raw_payload: {
      ...pendingAiTransaction.raw_payload,
      parserSource: "learned",
      validatedTemplate: null,
    },
  };
  const { calls, service } = createService(
    [
      [],
      [],
      [{ id: "import-1", transaction_id: "124", status: "pending" }],
      [deterministicPending],
    ],
    undefined,
    undefined,
    templates.repository,
  );

  const result = await service.handleEmailTransaction(
    unauthenticatedMatchingEmail,
  );

  assert.equal(result.status, "needs_review");
  assert.equal(result.transaction?.id, "124");
  assert.equal(result.actions?.confirm.transactionId, "124");
  assert.equal(
    calls.some((call) => /INSERT INTO transactions/.test(call.text)),
    false,
  );
});

test("redelivery resumes the same deterministic pending review with actions", async () => {
  const deterministicPending = {
    ...pendingAiTransaction,
    id: "124",
    raw_payload: {
      ...pendingAiTransaction.raw_payload,
      parserSource: "learned",
      validatedTemplate: null,
    },
  };
  const { service } = createService([
    [
      {
        id: "import-1",
        transaction_id: "124",
        status: "pending",
      },
    ],
    [deterministicPending],
  ]);

  const result = await service.handleEmailTransaction(
    unauthenticatedMatchingEmail,
  );

  assert.equal(result.status, "needs_review");
  assert.equal(result.transaction?.id, "124");
  assert.equal(result.aiRequest, undefined);
  const reviewResult = result as typeof result & {
    actions?: { confirm: { transactionId?: string } };
    replyMarkup?: unknown;
  };
  assert.equal(reviewResult.actions?.confirm.transactionId, "124");
  assert.ok(reviewResult.replyMarkup);
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
  assert.equal(
    (calls[4].values[8] as Record<string, unknown>).parserSource,
    "hardcoded",
  );
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

test("directly confirmed email credit-card expense adds cycle usage", async () => {
  const { service, transactionCalls } = createService([
    [],
    [{ canonical_name: "Toko Buku" }],
    [{ category: "Shopping" }],
    [{ id: "import-credit-card" }],
    [{ id: "tx-credit-card" }],
    [],
    [],
  ]);

  const result = await service.handleEmailTransaction({
    telegramUserId: "976684739",
    userId: 1,
    source: "email",
    email: {
      messageId: "gmail-credit-card",
      from: "card@bca.co.id",
      subject: "Notifikasi Transaksi",
      date: "2026-06-22T10:00:00+07:00",
      emailText:
        "Notifikasi Transaksi Merchant/ATM TOKO BUKU Jenis Transaksi Pembelian Sejumlah Rp123.456",
    },
  });

  assert.equal(result.status, "confirmed");
  const summaryCall = transactionCalls.find(({ text }) =>
    /INSERT INTO credit_card_cycle_summaries/.test(text),
  );
  assert.ok(summaryCall);
  assert.deepEqual(summaryCall.values, [
    "1",
    "2026-06-22T03:00:00.000Z",
    123456,
    123456,
  ]);
});

test("returns needs_review for BCA known template without category", async () => {
  const { calls, service } = createService([
    [],
    [{ canonical_name: "Toko Buku" }],
    [],
    [{ id: "import-review" }],
    [{ id: "125" }],
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
  assert.equal(result.transaction?.status, "pending");
  assert.ok((result as typeof result & { actions?: unknown }).actions);
  const callbacks =
    result.replyMarkup?.inline_keyboard
      .flat()
      .map((button) => button.callback_data) ?? [];
  assert.equal(
    callbacks.some((callback) => callback.startsWith("save_transaction:")),
    false,
  );
  assert.ok(
    callbacks.some((callback) => callback.startsWith("change_categories:")),
  );
  assert.ok(
    callbacks.some((callback) => callback.startsWith("edit_email_details:")),
  );
  assert.ok(
    callbacks.some((callback) => callback.startsWith("cancel_transaction:")),
  );
  assert.match(calls[3].text, /INSERT INTO transaction_imports/);
  assert.match(calls[4].text, /INSERT INTO transactions/);
  assert.match(calls[6].text, /INSERT INTO email_parse_attempts/);
});

test("returns needs_review for known email when merchant alias is missing", async () => {
  const { calls, service } = createService([
    [],
    [],
    [{ id: "import-alias-review" }],
    [{ id: "126" }],
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
  assert.equal(result.transaction?.status, "pending");
  assert.ok((result as typeof result & { actions?: unknown }).actions);
  const callbacks =
    result.replyMarkup?.inline_keyboard
      .flat()
      .map((button) => button.callback_data) ?? [];
  assert.equal(
    callbacks.some((callback) => callback.startsWith("save_transaction:")),
    false,
  );
  assert.ok(
    callbacks.some((callback) => callback.startsWith("change_categories:")),
  );
  assert.ok(
    callbacks.some((callback) => callback.startsWith("edit_email_details:")),
  );
  assert.ok(
    callbacks.some((callback) => callback.startsWith("cancel_transaction:")),
  );
  assert.equal(result.parsed?.merchant, "SHOPEE.CO.ID");
  assert.match(result.telegram.text, /Merchant: SHOPEE\.CO\.ID/);
  assert.equal(calls.length, 6);
  assert.match(calls[1].text, /FROM merchant_aliases/);
  assert.doesNotMatch(calls[2].text, /FROM category_rules/);
  assert.match(calls[2].text, /INSERT INTO transaction_imports/);
  assert.match(calls[3].text, /INSERT INTO transactions/);
  assert.match(calls[5].text, /INSERT INTO email_parse_attempts/);
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
      authentication: {
        dkim: "pass",
        spf: "pass",
        dmarc: "pass",
        domain: "bankmandiri.co.id",
      },
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

test("resolves a needs_ai email inside Core through the existing review path", async () => {
  const emailRequest: EmailTransactionHandleRequestDto = {
    telegramUserId: "976684739",
    userId: 1,
    source: "email",
    email: {
      messageId: "gmail-mandiri-core-ai",
      from: "bankmandiri@bankmandiri.co.id",
      subject: "Mandiri Transaction",
      date: "2026-06-22T10:00:00+07:00",
      emailText: "Mandiri Transaction berhasil sebesar Rp50.000",
      authentication: {
        dkim: "pass",
        spf: "pass",
        dmarc: "pass",
        domain: "bankmandiri.co.id",
      },
    },
  };
  const aiCalls: unknown[] = [];
  const veyraAiService = {
    reviewEmailTransaction: async (input: unknown) => {
      aiCalls.push(input);
      return {
        isTransaction: true as const,
        transactionCandidate: {
          source: "email" as const,
          bank: "Mandiri",
          transactionType: "expense",
          amount: 50000,
          merchant: "Toko Buku",
          merchantNormalized: "Toko Buku",
          transactionDate: "2026-06-22T10:00:00+07:00",
          rawPayload: {},
        },
        resolution: {
          category: "Shopping",
          confidence: 0.98,
          resolver: "llm",
        },
        templateProposal: null,
      };
    },
  } as unknown as VeyraAiService;
  const { calls, service } = createService(
    [
      [],
      [{ id: "import-mandiri" }],
      [],
      [{ id: "1", telegram_id: "976684739", timezone: "Asia/Jakarta" }],
      [{ category: "Shopping" }],
      [
        {
          id: "import-mandiri",
          transaction_id: null,
          status: "needs_ai",
          raw_payload: boundImportRaw(emailRequest.email),
        },
      ],
      [{ id: "123" }],
      [{ id: "import-mandiri" }],
    ],
    undefined,
    undefined,
    undefined,
    "1",
    veyraAiService,
  );

  const result = await service.handleEmailTransaction(emailRequest);

  assert.deepEqual(aiCalls, [
    {
      email: emailRequest.email,
      aiRequest: {
        reviewToken: "gmail-mandiri-core-ai",
        reason: "unsupported_template",
      },
    },
  ]);
  assert.equal(result.status, "needs_review");
  assert.equal(result.provider, "Mandiri");
  assert.equal(result.transaction?.id, "123");
  assert.equal(result.transaction?.status, "pending");
  assert.equal(result.transaction?.confidence, 98);
  assert.equal(result.aiRequest, undefined);
  assert.ok(
    result.replyMarkup?.inline_keyboard
      .flat()
      .some((button) => button.callback_data === "save_transaction:123"),
  );
  assert.equal(
    calls.filter((call) => /INSERT INTO transactions/.test(call.text)).length,
    1,
  );
});

test("records Core email AI failure without persisting a transaction", async () => {
  const emailRequest: EmailTransactionHandleRequestDto = {
    telegramUserId: "976684739",
    source: "email",
    email: {
      messageId: "gmail-mandiri-ai-failure",
      from: "bankmandiri@bankmandiri.co.id",
      subject: "Mandiri Transaction",
      emailText: "Mandiri Transaction berhasil sebesar Rp50.000",
      authentication: {
        dkim: "pass",
        spf: "pass",
        dmarc: "pass",
        domain: "bankmandiri.co.id",
      },
    },
  };
  const veyraAiService = {
    reviewEmailTransaction: async () => {
      throw new ServiceUnavailableException("private model failure");
    },
  } as unknown as VeyraAiService;
  const { calls, service } = createService(
    [
      [],
      [{ id: "import-mandiri" }],
      [],
      [{ id: "1", telegram_id: "976684739" }],
      [
        {
          id: "import-mandiri",
          raw_payload: boundImportRaw(emailRequest.email),
        },
      ],
      [],
    ],
    undefined,
    undefined,
    undefined,
    "1",
    veyraAiService,
  );

  const result = await service.handleEmailTransaction(emailRequest);

  assert.equal(result.status, "needs_review");
  assert.equal(result.reason, "ai_failed");
  assert.equal(result.transaction, undefined);
  assert.equal(result.aiRequest, undefined);
  assert.doesNotMatch(JSON.stringify(result), /private model failure/);
  assert.equal(
    calls.some((call) => /INSERT INTO transactions/.test(call.text)),
    false,
  );
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

test("manual confirmed save exposes watchdog-free base message", async () => {
  const { service } = createService([[], [{ id: "103" }]]);
  const watchdogCalls = spyOnWatchdog(service, {
    notifications: [
      {
        type: "risk_review",
        priority: 1,
        severity: "warning",
        message: "<b>Watchdog review</b>\nWas this planned?",
      },
    ],
  });

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
  assert.deepEqual(watchdogCalls, ["103"]);
  assert.equal(
    result.baseMessage,
    "✅ Recorded: Rp25.000 at Kopi Tuku under Coffee.",
  );
  assert.match(result.message, /Watchdog review/);
});

test("email confirmed save exposes watchdog-free base message", async () => {
  const { service } = createService([
    [],
    [{ canonical_name: "Kopi Tuku Canonical" }],
    [{ category: "Food" }],
    [{ id: "import-1" }],
    [{ id: "tx-email" }],
    [],
    [],
  ]);
  const watchdogCalls = spyOnWatchdog(service, {
    notifications: [
      {
        type: "risk_review",
        priority: 1,
        severity: "warning",
        message: "<b>Watchdog review</b>\nWas this planned?",
      },
    ],
  });

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
  assert.equal(
    result.baseMessage,
    "<b>Transaction recorded</b>\n\nAmount: Rp25.000\nMerchant: Kopi Tuku Canonical\nCategory: Food\nSource: Krom",
  );
  assert.match(result.telegram.text, /Watchdog review/);
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
    reviewToken: authenticatedUnknownKromEmail.email.messageId,
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
  const riskReplyMarkup = watchdogN8nFixture.notifications.riskReplyMarkup;
  const watchdogCalls = spyOnWatchdog(service, {
    notifications: [
      {
        type: "risk_review",
        priority: 1,
        severity: "high",
        review_id: 55,
        message: watchdogN8nFixture.notifications.messages[0],
        reply_markup: riskReplyMarkup,
      },
    ],
  });

  const result = await service.handleManagedTransaction(
    {
      telegramUserId: "976684739",
      text: "veyra_tx_manage:confirm",
      llmResult: null,
    },
    state.store,
  );

  assert.equal(result.status, "completed");
  assert.deepEqual(result.reply_markup, riskReplyMarkup);
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
    transactionId: "101",
    userId: "1",
  });

  assert.equal(result.status, "confirmed");
  assert.deepEqual(watchdogCalls, ["101"]);
});

test("pending transaction cancel skips watchdog", async () => {
  const { service } = createService([[transaction], []]);
  const watchdogCalls = spyOnWatchdog(service);

  const result = await service.cancelTransaction({
    transactionId: "101",
    userId: "1",
  });

  assert.equal(result.status, "rejected");
  assert.deepEqual(watchdogCalls, []);
});

test("Save activates the validated user template after confirming the transaction", async () => {
  const templates = createTemplateRepository();
  const { calls, service } = createService(
    [
      [pendingAiTransaction],
      [{ ...pendingAiTransaction, status: "confirmed" }],
      [{ id: "import-1" }],
      [{ raw_payload: pendingAiTransaction.raw_payload }],
      [],
      [],
      [],
      [],
    ],
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

test("only the winning pending email confirmation activates its template", async () => {
  const templates = createTemplateRepository();
  const confirmedTransaction = {
    ...pendingAiTransaction,
    status: "confirmed",
  };
  const { calls, service } = createService(
    [
      [pendingAiTransaction],
      [confirmedTransaction],
      [{ id: "import-1" }],
      [{ raw_payload: confirmedTransaction.raw_payload }],
      [],
      [],
      [],
      [],
      [],
      [pendingAiTransaction],
      [],
      [confirmedTransaction],
    ],
    undefined,
    undefined,
    templates.repository,
  );
  spyOnWatchdog(service);

  const first = await service.confirmTransaction({
    transactionId: "123",
    userId: "1",
  });
  const retry = await service.confirmTransaction({
    transactionId: "123",
    userId: "1",
  });

  assert.equal(first.status, "confirmed");
  assert.equal(retry.status, "already_confirmed");
  assert.equal(
    templates.calls.filter((call) => call.method === "activate").length,
    1,
  );
  const transitions = calls.filter(
    (call) =>
      /UPDATE transactions/.test(call.text) &&
      /source = 'email'/.test(call.text) &&
      /status = 'pending'/.test(call.text),
  );
  assert.equal(transitions.length, 2);
  assert.equal(
    transitions.every((call) => /status = 'pending'/.test(call.text)),
    true,
  );
  assert.equal(
    calls.filter((call) => /INSERT INTO merchant_aliases/.test(call.text))
      .length,
    1,
  );
  assert.equal(
    calls.filter((call) => /INSERT INTO category_rules/.test(call.text)).length,
    1,
  );
});

test("winning transition row drives confirmation response, activation, and learning", async () => {
  const authoritativeProposal: EmailParserTemplateProposalDto = {
    ...learnedProposal,
    templateKey: "authoritative-krom-qris",
  };
  const authoritativeTransaction = {
    ...pendingAiTransaction,
    merchant: "Authoritative Merchant",
    merchant_normalized: "Authoritative Canonical",
    category: "Dining",
    status: "confirmed",
    raw_payload: {
      ...pendingAiTransaction.raw_payload,
      validatedTemplate: {
        fingerprint: validatedFingerprint(
          authenticatedUnknownKromEmail.email,
          authoritativeProposal,
        ),
        proposal: authoritativeProposal,
      },
    },
  };
  const templates = createTemplateRepository();
  const { calls, service } = createService(
    [
      [pendingAiTransaction],
      [authoritativeTransaction],
      [{ id: "import-1" }],
      [{ raw_payload: authoritativeTransaction.raw_payload }],
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

  const result = await service.confirmTransaction({
    transactionId: "123",
    userId: "1",
  });

  assert.equal(result.summary?.merchant, "Authoritative Canonical");
  assert.equal(result.summary?.category, "Dining");
  const activation = templates.calls.find((call) => call.method === "activate")
    ?.input as ActivateEmailParserTemplateInput;
  assert.equal(activation.proposal.templateKey, "authoritative-krom-qris");
  const aliasInsert = calls.find((call) =>
    /INSERT INTO merchant_aliases/.test(call.text),
  );
  const categoryInsert = calls.find((call) =>
    /INSERT INTO category_rules/.test(call.text),
  );
  assert.deepEqual(aliasInsert?.values, [
    "Authoritative Merchant",
    "Authoritative Canonical",
  ]);
  assert.deepEqual(categoryInsert?.values, [
    "1",
    "Authoritative Canonical",
    "Dining",
  ]);
});

test("confirmation cannot apply after another cancellation wins", async () => {
  const templates = createTemplateRepository();
  const rejectedTransaction = {
    ...pendingTemplateTransaction,
    status: "rejected",
  };
  const { service } = createService(
    [
      [pendingTemplateTransaction],
      [rejectedTransaction],
      [{ id: "import-1" }],
      [pendingTemplateTransaction],
      [],
      [rejectedTransaction],
    ],
    undefined,
    undefined,
    templates.repository,
  );
  spyOnWatchdog(service);

  const cancelled = await service.cancelTransaction({
    transactionId: "123",
    userId: "1",
  });
  const confirmed = await service.confirmTransaction({
    transactionId: "123",
    userId: "1",
  });

  assert.equal(cancelled.status, "rejected");
  assert.equal(confirmed.status, "already_rejected");
  assert.equal(
    templates.calls.filter((call) => call.method === "activate").length,
    0,
  );
});

test("email confirmation rolls back when its import cannot transition and retries", async () => {
  const templates = createTemplateRepository();
  const { service, transactionEvents } = createService(
    [
      [pendingTemplateTransaction],
      [{ ...pendingTemplateTransaction, status: "confirmed" }],
      new Error("import unavailable"),
      [pendingTemplateTransaction],
      [{ ...pendingTemplateTransaction, status: "confirmed" }],
      [{ id: "import-1" }],
      [{ raw_payload: pendingTemplateTransaction.raw_payload }],
    ],
    undefined,
    undefined,
    templates.repository,
  );
  spyOnWatchdog(service);

  await assert.rejects(
    () =>
      service.confirmTransaction({
        transactionId: "123",
        userId: "1",
      }),
    /import unavailable/,
  );
  const retry = await service.confirmTransaction({
    transactionId: "123",
    userId: "1",
  });

  assert.equal(retry.status, "confirmed");
  assert.deepEqual(transactionEvents, [
    "begin",
    "rollback",
    "begin",
    "commit",
    "begin",
    "commit",
  ]);
  assert.equal(
    templates.calls.filter((call) => call.method === "activate").length,
    1,
  );
});

test("email import transition uses typed ids and email source", async () => {
  const templates = createTemplateRepository();
  const { calls, service } = createService(
    [
      [pendingTemplateTransaction],
      [{ ...pendingTemplateTransaction, status: "confirmed" }],
      [{ id: "import-1" }],
    ],
    undefined,
    undefined,
    templates.repository,
  );
  spyOnWatchdog(service);

  await service.confirmTransaction({ transactionId: "123", userId: "1" });

  const update = calls.find((call) =>
    /UPDATE transaction_imports/.test(call.text),
  );
  assert.ok(update);
  assert.match(update.text, /source = 'email'/);
  assert.match(update.text, /transaction_id = \$2/);
  assert.match(update.text, /user_id = \$3/);
  assert.doesNotMatch(update.text, /::text/);
});

test("malformed stored template does not activate after confirmation", async () => {
  const templates = createTemplateRepository();
  const malformed = {
    ...pendingTemplateTransaction,
    raw_payload: {
      ...pendingTemplateTransaction.raw_payload,
      validatedTemplate: {
        fingerprint: learnedTemplate.fingerprint,
        proposal: {
          ...learnedProposal,
          amount: { kind: "text", after: "Jumlah:", before: "Tanggal:" },
        },
      },
    },
  };
  const { service } = createService(
    [
      [malformed],
      [{ ...malformed, status: "confirmed" }],
      [{ id: "import-1" }],
    ],
    undefined,
    undefined,
    templates.repository,
  );
  spyOnWatchdog(service);

  const result = await service.confirmTransaction({
    transactionId: "123",
    userId: "1",
  });

  assert.equal(result.status, "confirmed");
  assert.equal(
    templates.calls.some((call) => call.method === "activate"),
    false,
  );
});

test("stored template fingerprint must match its proposal before activation", async () => {
  const templates = createTemplateRepository();
  const mismatched = {
    ...pendingTemplateTransaction,
    raw_payload: {
      ...pendingTemplateTransaction.raw_payload,
      validatedTemplate: {
        fingerprint: "f".repeat(64),
        proposal: learnedProposal,
      },
    },
  };
  const { service } = createService(
    [
      [mismatched],
      [{ ...mismatched, status: "confirmed" }],
      [{ id: "import-1" }],
    ],
    undefined,
    undefined,
    templates.repository,
  );
  spyOnWatchdog(service);

  const result = await service.confirmTransaction({
    transactionId: "123",
    userId: "1",
  });

  assert.equal(result.status, "confirmed");
  assert.equal(
    templates.calls.some((call) => call.method === "activate"),
    false,
  );
});

test("confirmed AI email learns a global alias and user category rule", async () => {
  const templates = createTemplateRepository();
  const { calls, service } = createService(
    [
      [pendingAiTransaction],
      [{ ...pendingAiTransaction, status: "confirmed" }],
      [{ id: "import-1" }],
      [{ raw_payload: pendingAiTransaction.raw_payload }],
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
  const { service, transactionEvents } = createService(
    [
      [pendingAiTransaction],
      [{ ...pendingAiTransaction, status: "confirmed" }],
      [{ id: "import-1" }],
      [{ raw_payload: pendingAiTransaction.raw_payload }],
      [],
      [],
      [],
      [],
    ],
    undefined,
    undefined,
    templates.repository,
  );

  const result = await service.confirmTransaction({
    transactionId: "123",
    userId: "1",
  });

  assert.equal(result.status, "confirmed");
  assert.deepEqual(transactionEvents, ["begin", "commit", "begin", "rollback"]);
});

test("an already confirmed Save retries only pending template activation", async () => {
  const templates = createTemplateRepository();
  let activationAttempts = 0;
  const activate = templates.repository.activate.bind(templates.repository);
  templates.repository.activate = async (input) => {
    activationAttempts += 1;
    if (activationAttempts === 1) throw new Error("temporary outage");
    return activate(input);
  };
  const confirmedWithPendingActivation = {
    ...pendingAiTransaction,
    status: "confirmed",
  };
  const confirmedAfterActivation = {
    ...confirmedWithPendingActivation,
    raw_payload: {
      ...confirmedWithPendingActivation.raw_payload,
      validatedTemplate: null,
    },
  };
  const { service } = createService(
    [
      [pendingAiTransaction],
      [confirmedWithPendingActivation],
      [{ id: "import-1" }],
      [{ raw_payload: confirmedWithPendingActivation.raw_payload }],
      [],
      [],
      [],
      [],
      [confirmedWithPendingActivation],
      [{ raw_payload: confirmedWithPendingActivation.raw_payload }],
      [],
      [confirmedAfterActivation],
    ],
    undefined,
    undefined,
    templates.repository,
  );
  spyOnWatchdog(service);

  const first = await service.confirmTransaction({
    transactionId: "123",
    userId: "1",
  });
  const retry = await service.confirmTransaction({
    transactionId: "123",
    userId: "1",
  });
  const repeated = await service.confirmTransaction({
    transactionId: "123",
    userId: "1",
  });

  assert.equal(first.status, "confirmed");
  assert.equal(retry.status, "already_confirmed");
  assert.equal(repeated.status, "already_confirmed");
  assert.equal(activationAttempts, 2);
});

test("Cancel never activates a proposed template", async () => {
  const templates = createTemplateRepository();
  const { calls, service } = createService(
    [
      [pendingAiTransaction],
      [{ ...pendingAiTransaction, status: "rejected" }],
      [{ id: "import-1" }],
    ],
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

test("binds an AI review token to the supplied Gmail message", async () => {
  const { calls, service } = createService([
    [{ id: "1", telegram_id: "976684739" }],
  ]);

  await assert.rejects(
    () =>
      service.resolveEmailTransactionReview(
        validAiReviewRequest({ reviewToken: "different-message" }),
      ),
    /reviewToken must match email.messageId/,
  );
  assert.equal(
    calls.some((call) => /FROM transactions/.test(call.text)),
    false,
  );
});

test("rejects altered sender authentication or body before initial AI writes", async () => {
  const storedRaw = boundImportRaw(authenticatedUnknownKromEmail.email);
  const alteredEmails: EmailTransactionMessageDto[] = [
    {
      ...authenticatedUnknownKromEmail.email,
      from: "attacker@krom.id",
    },
    {
      ...authenticatedUnknownKromEmail.email,
      authentication: {
        ...authenticatedUnknownKromEmail.email.authentication!,
        dkim: "fail",
      },
    },
    {
      ...authenticatedUnknownKromEmail.email,
      emailText: `${authenticatedUnknownKromEmail.email.emailText} altered`,
    },
  ];

  for (const email of alteredEmails) {
    const { calls, service } = createService([
      [{ id: "1", telegram_id: "976684739" }],
      [{ category: "Food" }],
      [
        {
          id: "import-1",
          transaction_id: null,
          status: "needs_ai",
          raw_payload: storedRaw,
        },
      ],
    ]);

    await assert.rejects(
      () =>
        service.resolveEmailTransactionReview(
          validAiReviewRequest({ email, reviewToken: email.messageId }),
        ),
      /email does not match original import/,
    );
    assert.equal(
      calls.some((call) => /INSERT INTO transactions/.test(call.text)),
      false,
    );
  }
});

test("rejects altered body before correction AI writes", async () => {
  const { calls, service } = createService([
    [{ id: "1", telegram_id: "976684739" }],
    [{ id: "123" }],
    [{ category: "Food" }],
    [
      {
        id: "import-1",
        transaction_id: "123",
        status: "pending",
        raw_payload: boundImportRaw(correctionEmail),
      },
    ],
  ]);

  await assert.rejects(
    () =>
      service.resolveEmailTransactionReview(
        validAiReviewRequest({
          transactionId: "123",
          email: {
            ...correctionEmail,
            emailText: `${correctionEmail.emailText} altered`,
          },
          reviewToken: correctionEmail.messageId,
          transactionCandidate: { ...aiCandidate, amount: 30000 },
          templateProposal: correctedKromProposal,
        }),
      ),
    /email does not match original import/,
  );
  assert.equal(
    calls.some((call) => /UPDATE transactions AS transaction/.test(call.text)),
    false,
  );
});

test("never upgrades a pre-hash import into a learnable correction", async () => {
  const legacyImportPayload = {
    email: {
      messageId: authenticatedUnknownKromEmail.email.messageId,
      from: authenticatedUnknownKromEmail.email.from,
      authentication: authenticatedUnknownKromEmail.email.authentication,
    },
  };
  const initial = createService([
    [{ id: "1", telegram_id: "976684739" }],
    [{ category: "Food" }],
    [
      {
        id: "import-1",
        transaction_id: null,
        status: "needs_ai",
        raw_payload: legacyImportPayload,
      },
    ],
    [{ id: "123" }],
    [{ id: "import-1" }],
    [],
  ]);

  await initial.service.resolveEmailTransactionReview(validAiReviewRequest());

  const attachedPayload = initial.calls.find(
    (call) =>
      /UPDATE transaction_imports/.test(call.text) &&
      /raw_payload = \$2/.test(call.text),
  )?.values[1] as Record<string, unknown>;
  const attachedEmail = attachedPayload.email as Record<string, unknown>;
  assert.equal(attachedEmail.binding, undefined);
  assert.equal(attachedPayload.validatedTemplate, null);

  const correction = createService([
    [{ id: "1", telegram_id: "976684739" }],
    [{ id: "123", user_id: "1", source: "email", status: "pending" }],
    [{ category: "Food" }],
    [
      {
        id: "import-1",
        transaction_id: "123",
        status: "pending",
        raw_payload: attachedPayload,
      },
    ],
    [{ id: "123" }],
    [],
  ]);

  await correction.service.resolveEmailTransactionReview(
    validAiReviewRequest({ transactionId: "123" }),
  );

  const correctedPayload = correction.calls.find((call) =>
    /UPDATE transactions AS transaction/.test(call.text),
  )?.values[8] as Record<string, unknown>;
  const correctedEmail = correctedPayload.email as Record<string, unknown>;
  assert.equal(correctedEmail.binding, undefined);
  assert.equal(correctedPayload.validatedTemplate, null);
});

test("binds AI correction SQL to one import with contiguous placeholders", async () => {
  const { calls, service } = createService([
    [{ id: "1", telegram_id: "976684739" }],
    [{ id: "123" }],
    [{ category: "Food" }],
    [
      {
        id: "import-1",
        transaction_id: "123",
        status: "pending",
        raw_payload: boundImportRaw(correctionEmail),
      },
    ],
    [{ id: "123" }],
    [],
  ]);

  await service.resolveEmailTransactionReview(
    validAiReviewRequest({
      transactionId: "123",
      email: correctionEmail,
      reviewToken: correctionEmail.messageId,
      transactionCandidate: { ...aiCandidate, amount: 30000 },
      templateProposal: correctedKromProposal,
    }),
  );

  const update = calls.find((call) =>
    /UPDATE transactions AS transaction/.test(call.text),
  );
  assert.ok(update);
  assert.match(update.text, /FROM transaction_imports AS email_import/);
  assert.match(update.text, /email_import\.transaction_id = transaction\.id/);
  assert.match(update.text, /email_import\.source_reference = \$12/);
  assert.deepEqual(
    [...update.text.matchAll(/\$(\d+)/g)].map((match) => Number(match[1])),
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
  );
  assert.equal(update.values.length, 12);
  assert.ok((update.values[8] as Record<string, unknown>).validatedTemplate);
});

test("drops a replayable proposal that does not reproduce the AI candidate", async () => {
  const { calls, service } = createService([
    [{ id: "1", telegram_id: "976684739" }],
    [{ category: "Food" }],
    [{ id: "import-1", transaction_id: null, status: "needs_ai" }],
    [{ id: "123" }],
    [{ id: "import-1" }],
  ]);

  const result = await service.resolveEmailTransactionReview(
    validAiReviewRequest({
      transactionCandidate: { ...aiCandidate, amount: 30000 },
    }),
  );

  assert.equal(result.status, "pending");
  const insert = calls.find((call) =>
    /INSERT INTO transactions/.test(call.text),
  );
  const rawPayload = insert?.values[10] as Record<string, unknown>;
  assert.equal(rawPayload.validatedTemplate, null);
});

test("clears the stored proposal after a material correction no longer matches it", async () => {
  const { calls, service } = createService([
    [{ id: "1", telegram_id: "976684739" }],
    [{ id: "123" }],
    [{ category: "Food" }],
    [{ id: "import-1", transaction_id: "123", status: "pending" }],
    [{ id: "123" }],
    [],
  ]);

  await service.resolveEmailTransactionReview(
    validAiReviewRequest({
      transactionId: "123",
      transactionCandidate: { ...aiCandidate, amount: 30000 },
    }),
  );

  const update = calls.find((call) =>
    /UPDATE transactions AS transaction/.test(call.text),
  );
  const rawPayload = update?.values[8] as Record<string, unknown>;
  assert.equal(rawPayload.validatedTemplate, null);
});

test("does not persist or return caller text from a correction AI failure", async () => {
  const privateAiError = "email body leaked: password=hunter2 account=99887766";
  const { calls, service } = createService([
    [{ id: "1", telegram_id: "976684739" }],
    [{ id: "123" }],
    [{ id: "import-1" }],
    [],
  ]);

  const result = await service.resolveEmailTransactionReview({
    telegramUserId: "976684739",
    reviewToken: authenticatedUnknownKromEmail.email.messageId,
    transactionId: "123",
    email: authenticatedUnknownKromEmail.email,
    aiError: privateAiError,
  });

  assert.equal(result.status, "needs_review");
  assert.equal(result.reason, "ai_failed");
  assert.equal(result.message, "AI processing failed");
  const binding = calls.find((call) =>
    /JOIN transaction_imports/.test(call.text),
  );
  const update = calls.find((call) =>
    /UPDATE transaction_imports/.test(call.text),
  );
  assert.ok(binding);
  assert.match(binding.text, /transaction\.status = 'pending'/);
  assert.match(binding.text, /email_import\.source_reference = \$3/);
  assert.ok(update);
  assert.match(update.text, /FROM transactions AS transaction/);
  assert.match(update.text, /transaction_id = \$4/);
  assert.match(update.text, /transaction\.status = 'pending'/);
  assert.match(update.text, /FOR UPDATE OF transaction, email_import/);
  assert.match(update.text, /status = 'pending'/);
  assert.doesNotMatch(update.text, /SET status = 'needs_review'/);
  assert.match(update.text, /RETURNING email_import\.id/);
  assert.deepEqual(update.values, [
    "1",
    authenticatedUnknownKromEmail.email.messageId,
    "AI processing failed",
    "123",
  ]);
  const attemptUpdate = calls.find((call) =>
    /UPDATE email_parse_attempts/.test(call.text),
  );
  assert.ok(attemptUpdate);
  assert.deepEqual(attemptUpdate.values, [
    "1",
    authenticatedUnknownKromEmail.email.messageId,
    "AI processing failed",
  ]);
  assert.doesNotMatch(JSON.stringify(result), /hunter2|99887766/);
  assert.doesNotMatch(JSON.stringify(update.values), /hunter2|99887766/);
  assert.doesNotMatch(JSON.stringify(attemptUpdate.values), /hunter2|99887766/);
  assert.equal(
    calls.some((call) => /UPDATE transactions/.test(call.text)),
    false,
  );
});

test("retries a bound correction after its AI failure", async () => {
  const { calls, service } = createService([
    [{ id: "1", telegram_id: "976684739" }],
    [{ id: "123" }],
    [{ id: "import-1" }],
    [],
    [{ id: "1", telegram_id: "976684739" }],
    [{ id: "123" }],
    [{ category: "Food" }],
    [{ id: "import-1", transaction_id: "123", status: "pending" }],
    [{ id: "123" }],
    [],
  ]);
  const failure = {
    telegramUserId: "976684739",
    reviewToken: correctionEmail.messageId,
    transactionId: "123",
    email: correctionEmail,
    aiError: "model unavailable",
  };

  const failed = await service.resolveEmailTransactionReview(failure);
  const retried = await service.resolveEmailTransactionReview(
    validAiReviewRequest({
      transactionId: "123",
      email: correctionEmail,
      reviewToken: correctionEmail.messageId,
      transactionCandidate: { ...aiCandidate, amount: 30000 },
      templateProposal: correctedKromProposal,
    }),
  );

  assert.equal(failed.status, "needs_review");
  assert.equal(retried.status, "pending");
  assert.equal(retried.transaction?.id, "123");
  const successfulAttemptUpdate = calls.find(
    (call) =>
      /UPDATE email_parse_attempts/.test(call.text) &&
      /error_reason = NULL/.test(call.text),
  );
  assert.ok(successfulAttemptUpdate);
  assert.match(successfulAttemptUpdate.text, /status = 'pending'/);
});

test("correction AI failure rejects cross-email or terminal transaction binding", async () => {
  const { calls, service } = createService([
    [{ id: "1", telegram_id: "976684739" }],
    [],
  ]);

  await assert.rejects(
    () =>
      service.resolveEmailTransactionReview({
        telegramUserId: "976684739",
        reviewToken: correctionEmail.messageId,
        transactionId: "123",
        email: correctionEmail,
        aiError: "model unavailable",
      }),
    /pending email transaction was not found/,
  );

  const binding = calls.find((call) =>
    /JOIN transaction_imports/.test(call.text),
  );
  assert.ok(binding);
  assert.match(binding.text, /transaction\.status = 'pending'/);
  assert.match(binding.text, /email_import\.status = 'pending'/);
  assert.equal(
    calls.some((call) => /UPDATE transaction_imports/.test(call.text)),
    false,
  );
});

test("rejects malformed bigint IDs before direct PostgreSQL comparisons", async () => {
  for (const telegramUserId of ["not-a-bigint", "9223372036854775808"]) {
    const invalidTelegram = createService();
    await assert.rejects(
      () =>
        invalidTelegram.service.resolveEmailTransactionReview(
          validAiReviewRequest({ telegramUserId }),
        ),
      /telegramUserId must be a positive integer/,
    );
    assert.deepEqual(invalidTelegram.calls, []);
  }

  for (const request of [
    { transactionId: "not-a-bigint", userId: "1" },
    { transactionId: "123", userId: "not-a-bigint" },
    { transactionId: "9223372036854775808", userId: "1" },
    { transactionId: "123", userId: "9223372036854775808" },
  ]) {
    const invalidTransaction = createService();
    const result = await invalidTransaction.service.confirmTransaction(request);
    assert.equal(result.status, "not_found");
    assert.deepEqual(invalidTransaction.calls, []);
  }
});

test("a failed AI import without a transaction resumes the AI handoff", async () => {
  const { service } = createService([
    [
      {
        id: "import-1",
        transaction_id: null,
        status: "needs_review",
        raw_payload: {
          aiRequest: {
            reviewToken: "gmail-learned-1",
            reason: "unsupported_template",
          },
        },
      },
    ],
  ]);

  const result = await service.handleEmailTransaction(originalAiEmail);

  assert.equal(result.status, "needs_ai");
  assert.equal(result.aiRequest?.reviewToken, "gmail-learned-1");
});

test("rejects altered redelivery before resuming Core email AI", async () => {
  const storedRaw = boundImportRaw(originalAiEmail.email);
  let aiCalls = 0;
  const veyraAiService = {
    reviewEmailTransaction: async () => {
      aiCalls += 1;
      return { isTransaction: false as const };
    },
  } as unknown as VeyraAiService;
  const { service } = createService(
    [
      [
        {
          id: "import-1",
          transaction_id: null,
          status: "needs_ai",
          raw_payload: storedRaw,
        },
      ],
      [{ id: "import-1", raw_payload: storedRaw }],
    ],
    undefined,
    undefined,
    undefined,
    "1",
    veyraAiService,
  );

  await assert.rejects(
    () =>
      service.handleEmailTransaction({
        ...originalAiEmail,
        email: {
          ...originalAiEmail.email,
          emailText: `${originalAiEmail.email.emailText} altered`,
        },
      }),
    /email does not match original import/,
  );
  assert.equal(aiCalls, 0);
});

test("records an explicit AI non-transaction decision idempotently", async () => {
  const { calls, service } = createService([
    [{ id: "1", telegram_id: "976684739" }],
    [{ id: "import-1" }],
    [{ id: "attempt-1" }],
    [{ id: "1", telegram_id: "976684739" }],
    [{ id: "import-1" }],
    [{ id: "attempt-1" }],
  ]);
  const request: EmailTransactionResolveReviewRequestDto = {
    telegramUserId: "976684739",
    reviewToken: authenticatedUnknownKromEmail.email.messageId,
    email: authenticatedUnknownKromEmail.email,
    isTransaction: false,
  };

  const first = await service.resolveEmailTransactionReview(request);
  const retry = await service.resolveEmailTransactionReview(request);

  assert.equal(first.status, "ignored_non_transaction");
  assert.equal(retry.status, "ignored_non_transaction");
  assert.equal(
    calls.some((call) => /INSERT INTO transactions/.test(call.text)),
    false,
  );
  const importUpdates = calls.filter((call) =>
    /UPDATE transaction_imports/.test(call.text),
  );
  assert.equal(importUpdates.length, 2);
  assert.equal(
    JSON.stringify(importUpdates[0].values).includes("emailText"),
    false,
  );
});

test("does not activate a confirmed AI template without aligned sender auth", async () => {
  const weakAuthTransaction = {
    ...pendingAiTransaction,
    raw_payload: {
      ...pendingAiTransaction.raw_payload,
      email: {
        ...pendingAiTransaction.raw_payload.email,
        authentication: {
          dkim: "fail",
          spf: "pass",
          dmarc: "fail",
          domain: "krom.id",
        },
      },
    },
  };
  const templates = createTemplateRepository();
  const { service } = createService(
    [
      [weakAuthTransaction],
      [{ ...weakAuthTransaction, status: "confirmed" }],
      [{ id: "import-1" }],
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

  const result = await service.confirmTransaction({
    transactionId: "123",
    userId: "1",
  });

  assert.equal(result.status, "confirmed");
  assert.equal(
    templates.calls.some((call) => call.method === "activate"),
    false,
  );
});

test("does not activate or learn from a pre-hash AI transaction", async () => {
  const unbound = {
    ...pendingAiTransaction,
    raw_payload: {
      ...pendingAiTransaction.raw_payload,
      email: {
        messageId: authenticatedUnknownKromEmail.email.messageId,
        from: authenticatedUnknownKromEmail.email.from,
        authentication: authenticatedUnknownKromEmail.email.authentication,
      },
    },
  };
  const confirmed = { ...unbound, status: "confirmed" };
  const templates = createTemplateRepository();
  const { calls, service } = createService(
    [
      [unbound],
      [confirmed],
      [{ id: "import-1" }],
      [{ raw_payload: confirmed.raw_payload }],
      [],
    ],
    undefined,
    undefined,
    templates.repository,
  );

  const result = await service.confirmTransaction({
    transactionId: "123",
    userId: "1",
  });

  assert.equal(result.status, "confirmed");
  assert.equal(
    templates.calls.some((call) => call.method === "activate"),
    false,
  );
  assert.equal(
    calls.some((call) => /merchant_aliases|category_rules/.test(call.text)),
    false,
  );
});

test("reconciles a pre-branch pending email review without an attached import", async () => {
  const { calls, service, transactionEvents } = createService([
    [pendingTemplateTransaction],
    [{ ...pendingTemplateTransaction, status: "confirmed" }],
    [],
    [{ id: "import-backfill" }],
  ]);
  spyOnWatchdog(service);

  const result = await service.confirmTransaction({
    transactionId: "123",
    userId: "1",
  });

  assert.equal(result.status, "confirmed");
  const reconciliation = calls.find((call) =>
    /INSERT INTO transaction_imports/.test(call.text),
  );
  assert.ok(reconciliation);
  assert.match(
    reconciliation.text,
    /ON CONFLICT \(user_id, source, source_reference\) DO UPDATE/,
  );
  assert.deepEqual(transactionEvents, ["begin", "commit"]);
});

test("confirms a legacy email review that predates stored Gmail identity", async () => {
  const legacy = {
    ...pendingAiTransaction,
    raw_payload: { legacyCandidate: true },
  };
  const { calls, service, transactionEvents } = createService([
    [legacy],
    [{ ...legacy, status: "confirmed" }],
    [],
  ]);
  spyOnWatchdog(service);

  const result = await service.confirmTransaction({
    transactionId: "123",
    userId: "1",
  });

  assert.equal(result.status, "confirmed");
  assert.equal(
    calls.some((call) => /INSERT INTO transaction_imports/.test(call.text)),
    false,
  );
  assert.deepEqual(transactionEvents, ["begin", "commit"]);
});

test("AI confirmation text exposes transaction type and date", async () => {
  const result = await resolveValidAiReview();

  assert.match(result.telegramText ?? "", /Type: Expense/);
  assert.match(result.telegramText ?? "", /Date: 2026-07-27/);
});

test("rolls back a learned material edit when template disable fails", async () => {
  const templates = createTemplateRepository(
    [],
    undefined,
    new Error("disable unavailable"),
  );
  const state = createManageStateStore({
    stateName: "confirm_action",
    stateData: {
      action: "edit",
      transaction_id: "123",
      before: learnedParsedTransaction,
      changes: { amount: 30000 },
    },
  });
  const { service, transactionCalls, transactionEvents } = createService(
    [[{ id: "1", telegram_id: "976684739" }], [learnedParsedTransaction], []],
    undefined,
    undefined,
    templates.repository,
  );

  await assert.rejects(
    () =>
      service.handleManagedTransaction(
        {
          telegramUserId: "976684739",
          text: "veyra_tx_manage:confirm",
          llmResult: null,
        },
        state.store,
      ),
    /disable unavailable/,
  );

  assert.deepEqual(transactionEvents, ["begin", "rollback"]);
  assert.equal(
    transactionCalls.some((call) =>
      /UPDATE email_parser_templates/.test(call.text),
    ),
    true,
  );
  assert.equal(state.state.stateName, "confirm_action");
});

test("derives the email owner from telegramUserId and rejects a claimed mismatch", async () => {
  const templates = createTemplateRepository([]);
  const { calls, service } = createService(
    [],
    undefined,
    undefined,
    templates.repository,
    "2",
  );

  await assert.rejects(
    () => service.handleEmailTransaction(authenticatedUnknownBankTransaction),
    /userId does not match telegramUserId/,
  );

  assert.equal(
    calls.some((call) => /FROM transaction_imports/.test(call.text)),
    false,
  );
  assert.deepEqual(templates.calls, []);
});

test("completes failure redelivery as non-transaction and keeps the retry idempotent", async () => {
  const failedImport = {
    id: "import-1",
    transaction_id: null,
    status: "needs_review",
    raw_payload: {
      aiRequest: {
        reviewToken: authenticatedUnknownKromEmail.email.messageId,
        reason: "unsupported_template",
      },
    },
  };
  const { calls, service } = createService([
    [{ id: "1", telegram_id: "976684739" }],
    [{ id: "import-1" }],
    [],
    [failedImport],
    [{ id: "1", telegram_id: "976684739" }],
    [{ id: "import-1" }],
    [{ id: "attempt-1" }],
    [{ id: "1", telegram_id: "976684739" }],
    [{ id: "import-1" }],
    [{ id: "attempt-1" }],
  ]);
  const failure = {
    telegramUserId: "976684739",
    reviewToken: authenticatedUnknownKromEmail.email.messageId,
    email: authenticatedUnknownKromEmail.email,
    aiError: "model unavailable",
  };
  const nonTransaction: EmailTransactionResolveReviewRequestDto = {
    telegramUserId: "976684739",
    reviewToken: authenticatedUnknownKromEmail.email.messageId,
    email: authenticatedUnknownKromEmail.email,
    isTransaction: false,
  };

  const failed = await service.resolveEmailTransactionReview(failure);
  const redelivery = await service.handleEmailTransaction(originalAiEmail);
  const resolved = await service.resolveEmailTransactionReview(nonTransaction);
  const retry = await service.resolveEmailTransactionReview(nonTransaction);

  assert.equal(failed.status, "needs_review");
  assert.equal(redelivery.status, "needs_ai");
  assert.equal(resolved.status, "ignored_non_transaction");
  assert.equal(retry.status, "ignored_non_transaction");
  const importResolutions = calls.filter(
    (call) =>
      /UPDATE transaction_imports/.test(call.text) &&
      /SET status = 'ignored_non_transaction'/.test(call.text),
  );
  assert.equal(importResolutions.length, 2);
  assert.ok(
    importResolutions.every(
      (call) =>
        /transaction_id IS NULL/.test(call.text) &&
        /'needs_review'/.test(call.text) &&
        /'ignored_non_transaction'/.test(call.text),
    ),
  );
});

test("rejects contradictory AI result modes before persistence", async () => {
  for (const request of [
    {
      telegramUserId: "976684739",
      reviewToken: authenticatedUnknownKromEmail.email.messageId,
      email: authenticatedUnknownKromEmail.email,
      aiError: "model unavailable",
      isTransaction: false,
    },
    {
      ...validAiReviewRequest(),
      isTransaction: false,
    },
  ] as EmailTransactionResolveReviewRequestDto[]) {
    const { calls, service } = createService([
      [{ id: "1", telegram_id: "976684739" }],
    ]);

    await assert.rejects(
      () => service.resolveEmailTransactionReview(request),
      /result mode/,
    );
    assert.equal(
      calls.some((call) => /UPDATE|INSERT/.test(call.text)),
      false,
    );
  }
});

test("material AI edit clears its proposal so later Save cannot activate it", async () => {
  const clearedPayload = {
    ...pendingAiTransaction.raw_payload,
    validatedTemplate: null,
  };
  const edited = {
    ...pendingAiTransaction,
    amount: "30000",
    raw_payload: clearedPayload,
  };
  const templates = createTemplateRepository();
  const state = createManageStateStore({
    stateName: "confirm_action",
    stateData: {
      action: "edit",
      transaction_id: "123",
      before: pendingAiTransaction,
      changes: { amount: 30000 },
    },
  });
  const { calls, service } = createService(
    [
      [{ id: "1", telegram_id: "976684739" }],
      [pendingAiTransaction],
      [{ id: "123" }],
      [edited],
      [{ ...edited, status: "confirmed" }],
      [{ id: "import-1" }],
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

  await service.handleManagedTransaction(
    {
      telegramUserId: "976684739",
      text: "veyra_tx_manage:confirm",
      llmResult: null,
    },
    state.store,
  );
  const saved = await service.confirmTransaction({
    transactionId: "123",
    userId: "1",
  });

  const edit = calls.find(
    (call) =>
      /UPDATE transactions/.test(call.text) && /amount = \$1/.test(call.text),
  );
  assert.ok(edit);
  assert.match(edit.text, /raw_payload = \$2/);
  assert.deepEqual(edit.values[1], clearedPayload);
  assert.equal(saved.status, "confirmed");
  assert.equal(
    templates.calls.some((call) => call.method === "activate"),
    false,
  );
});

test("material AI edit rejects a concurrent status change", async () => {
  const state = createManageStateStore({
    stateName: "confirm_action",
    stateData: {
      action: "edit",
      transaction_id: "123",
      before: pendingAiTransaction,
      changes: { amount: 30000 },
    },
  });
  const { calls, service, transactionEvents } = createService([
    [{ id: "1", telegram_id: "976684739" }],
    [pendingAiTransaction],
    [],
  ]);

  await assert.rejects(
    () =>
      service.handleManagedTransaction(
        {
          telegramUserId: "976684739",
          text: "veyra_tx_manage:confirm",
          llmResult: null,
        },
        state.store,
      ),
    /transaction changed before the edit completed/,
  );

  const edit = calls.find(
    (call) =>
      /UPDATE transactions/.test(call.text) && /amount = \$1/.test(call.text),
  );
  assert.ok(edit);
  assert.match(edit.text, /status = 'pending'/);
  assert.match(edit.text, /source = 'email'/);
  assert.match(edit.text, /raw_payload ->> 'parserSource' = 'ai'/);
  assert.deepEqual(transactionEvents, ["begin", "rollback"]);
  assert.equal(state.state.stateName, "confirm_action");
});

test("material AI date edit refreshes the body-free fallback date", async () => {
  const originalDate = "2026-07-28T00:30:00+07:00";
  const oldPayload = {
    ...pendingAiTransaction.raw_payload,
    reviewContext: {
      timeZone: null,
      originalTransactionDate: "2026-07-27T00:30:00+07:00",
    },
  };
  const pending = {
    ...pendingAiTransaction,
    transaction_date: "2026-07-26T17:30:00.000Z",
    raw_payload: oldPayload,
  };
  const editedPayload = {
    ...oldPayload,
    reviewContext: {
      timeZone: null,
      originalTransactionDate: originalDate,
    },
    validatedTemplate: null,
  };
  const edited = {
    ...pending,
    transaction_date: "2026-07-27T17:30:00.000Z",
    raw_payload: editedPayload,
  };
  const state = createManageStateStore({
    stateName: "confirm_action",
    stateData: {
      action: "edit",
      transaction_id: "123",
      before: pending,
      changes: { transaction_date: originalDate },
    },
  });
  const manage = createService([
    [{ id: "1", telegram_id: "976684739" }],
    [pending],
    [{ id: "123" }],
  ]);
  spyOnWatchdog(manage.service);
  const save = createService([
    [edited],
    [{ ...edited, status: "confirmed" }],
    [{ id: "import-1" }],
  ]);
  spyOnWatchdog(save.service);

  await manage.service.handleManagedTransaction(
    {
      telegramUserId: "976684739",
      text: "veyra_tx_manage:confirm",
      llmResult: null,
    },
    state.store,
  );
  const saved = await save.service.confirmTransaction({
    transactionId: "123",
    userId: "1",
  });

  const edit = manage.calls.find(
    (call) =>
      /UPDATE transactions/.test(call.text) &&
      /transaction_date = \$1/.test(call.text),
  );
  assert.ok(edit);
  assert.equal(edit.values[0], "2026-07-27T17:30:00.000Z");
  assert.deepEqual(edit.values[1], editedPayload);
  assert.match(saved.editMessage?.text ?? "", /Date: 2026-07-28/);
});

test("failed material AI edit rolls back without clearing its proposal", async () => {
  const state = createManageStateStore({
    stateName: "confirm_action",
    stateData: {
      action: "edit",
      transaction_id: "123",
      before: pendingAiTransaction,
      changes: { amount: 30000 },
    },
  });
  const { service, transactionEvents } = createService([
    [{ id: "1", telegram_id: "976684739" }],
    [pendingAiTransaction],
    new Error("edit unavailable"),
  ]);

  await assert.rejects(
    () =>
      service.handleManagedTransaction(
        {
          telegramUserId: "976684739",
          text: "veyra_tx_manage:confirm",
          llmResult: null,
        },
        state.store,
      ),
    /edit unavailable/,
  );

  assert.deepEqual(transactionEvents, ["begin", "rollback"]);
  assert.ok(pendingAiTransaction.raw_payload.validatedTemplate);
  assert.equal(state.state.stateName, "confirm_action");
});

test("rolls back non-transaction import state when attempt update fails", async () => {
  const { service, transactionEvents } = createService([
    [{ id: "1", telegram_id: "976684739" }],
    [{ id: "import-1" }],
    new Error("attempt unavailable"),
  ]);

  await assert.rejects(
    () =>
      service.resolveEmailTransactionReview({
        telegramUserId: "976684739",
        reviewToken: authenticatedUnknownKromEmail.email.messageId,
        email: authenticatedUnknownKromEmail.email,
        isTransaction: false,
      }),
    /attempt unavailable/,
  );

  assert.deepEqual(transactionEvents, ["begin", "rollback"]);
});

test("formats AI review dates in the resolved Telegram user timezone", async () => {
  const midnightCandidate = {
    ...aiCandidate,
    transactionDate: "2026-07-27T00:30:00+07:00",
  };
  const { calls, service } = createService([
    [
      {
        id: "1",
        telegram_id: "976684739",
        timezone: "Asia/Jakarta",
      },
    ],
    [{ category: "Food" }],
    [{ id: "import-1", transaction_id: null, status: "needs_ai" }],
    [{ id: "123" }],
    [{ id: "import-1" }],
  ]);

  const result = await service.resolveEmailTransactionReview(
    validAiReviewRequest({
      transactionCandidate: midnightCandidate,
      templateProposal: undefined,
    }),
  );

  assert.match(result.telegramText ?? "", /Date: 2026-07-27/);
  const insert = calls.find((call) =>
    /INSERT INTO transactions/.test(call.text),
  );
  const rawPayload = insert?.values[10] as Record<string, unknown>;
  assert.deepEqual(rawPayload.reviewContext, {
    timeZone: "Asia/Jakarta",
    originalTransactionDate: "2026-07-27T00:30:00+07:00",
  });
});

test("Save and category confirmation preserve the Jakarta transaction date", async () => {
  const rawPayload = {
    email: {
      messageId: "gmail-midnight",
      from: "alerts@krom.id",
    },
    parserSource: "review",
    reviewContext: {
      timeZone: "Asia/Jakarta",
      originalTransactionDate: "2026-07-27T00:30:00+07:00",
    },
  };
  const pending = {
    ...pendingAiTransaction,
    transaction_date: "2026-07-26T17:30:00.000Z",
    raw_payload: rawPayload,
  };
  const confirmed = { ...pending, status: "confirmed" };
  const save = createService([[pending], [confirmed], [{ id: "import-save" }]]);
  spyOnWatchdog(save.service);
  const category = createService([
    [pending],
    [{ id: "budget-food", category: "Dining", parent_category: null }],
    [{ ...confirmed, category: "Dining" }],
    [{ id: "import-category" }],
  ]);
  spyOnWatchdog(category.service);

  const saved = await save.service.confirmTransaction({
    transactionId: "123",
    userId: "1",
  });
  const categorized = await category.service.setPendingTransactionCategory({
    transactionId: "123",
    budgetId: "budget-food",
    userId: "1",
  });

  assert.match(saved.editMessage?.text ?? "", /Date: 2026-07-27/);
  assert.match(categorized.editMessage?.text ?? "", /Date: 2026-07-27/);
});

test("category confirmation activates the proposal exactly once", async () => {
  const templates = createTemplateRepository();
  const { service } = createService(
    [
      [pendingAiTransaction],
      [{ id: "budget-food", category: "Dining", parent_category: null }],
      [{ ...pendingAiTransaction, category: "Dining", status: "confirmed" }],
      [{ id: "import-1" }],
      [{ raw_payload: pendingAiTransaction.raw_payload }],
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

test("only the winning category confirmation activates its template", async () => {
  const templates = createTemplateRepository();
  const confirmedTransaction = {
    ...pendingTemplateTransaction,
    category: "Dining",
    status: "confirmed",
  };
  const budget = {
    id: "budget-food",
    category: "Dining",
    parent_category: null,
  };
  const { service } = createService(
    [
      [pendingTemplateTransaction],
      [budget],
      [confirmedTransaction],
      [{ id: "import-1" }],
      [{ raw_payload: confirmedTransaction.raw_payload }],
      [],
      [pendingTemplateTransaction],
      [budget],
      [],
      [confirmedTransaction],
    ],
    undefined,
    undefined,
    templates.repository,
  );
  spyOnWatchdog(service);

  const first = await service.setPendingTransactionCategory({
    transactionId: "123",
    budgetId: "budget-food",
    userId: "1",
  });
  const retry = await service.setPendingTransactionCategory({
    transactionId: "123",
    budgetId: "budget-food",
    userId: "1",
  });

  assert.equal(first.status, "updated");
  assert.equal(retry.status, "already_resolved");
  assert.equal(
    templates.calls.filter((call) => call.method === "activate").length,
    1,
  );
});

test("category confirmation uses the authoritative transition row", async () => {
  const authoritativeProposal: EmailParserTemplateProposalDto = {
    ...learnedProposal,
    templateKey: "authoritative-category-krom",
  };
  const authoritativeTransaction = {
    ...pendingAiTransaction,
    merchant: "Corrected Merchant",
    merchant_normalized: "Corrected Canonical",
    category: "Dining",
    status: "confirmed",
    raw_payload: {
      ...pendingAiTransaction.raw_payload,
      validatedTemplate: {
        fingerprint: validatedFingerprint(
          authenticatedUnknownKromEmail.email,
          authoritativeProposal,
        ),
        proposal: authoritativeProposal,
      },
    },
  };
  const templates = createTemplateRepository();
  const { service } = createService(
    [
      [pendingAiTransaction],
      [{ id: "budget-food", category: "Dining", parent_category: null }],
      [authoritativeTransaction],
      [{ id: "import-1" }],
      [{ raw_payload: authoritativeTransaction.raw_payload }],
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

  assert.equal(result.summary?.merchant, "Corrected Canonical");
  assert.equal(result.summary?.category, "Dining");
  const activation = templates.calls.find((call) => call.method === "activate")
    ?.input as ActivateEmailParserTemplateInput;
  assert.equal(activation.proposal.templateKey, "authoritative-category-krom");
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
    transactionId: "101",
    budgetId: "budget-food",
    userId: "1",
  });

  assert.equal(result.status, "updated");
  assert.deepEqual(watchdogCalls, ["101"]);
  assert.equal(result.editMessage?.parseMode, "HTML");
});

test("watchdog preserves n8n fixture order for all notifications", async (t) => {
  t.mock.timers.enable({
    apis: ["Date"],
    now: new Date("2026-08-04T12:00:00.000Z"),
  });
  const today = new Date();
  const cycleStartDay = today.getUTCDate();
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
    transactionId: "101",
  });
  const { service } = createService(
    [
      [
        {
          ...transaction,
          id: "101",
          user_id: "1",
          transaction_type: "expense",
          transaction_date: today.toISOString(),
          status: "confirmed",
        },
      ],
      [{ cycle_start_day: cycleStartDay }],
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
      [{ cycle_start_day: cycleStartDay }],
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

  const result = await service.evaluateTransactionWatchdog("101");

  assert.deepEqual(
    result.notifications.map(({ type }) => type),
    watchdogN8nFixture.notifications.orderedTypes,
  );
  assert.deepEqual(
    result.notifications.map(({ priority }) => priority),
    watchdogN8nFixture.notifications.priorities,
  );
  assert.deepEqual(
    {
      messages: result.notifications.map(({ message }) => message),
      riskReplyMarkup: result.notifications[0].reply_markup,
    },
    {
      messages: watchdogN8nFixture.notifications.messages,
      riskReplyMarkup: watchdogN8nFixture.notifications.riskReplyMarkup,
    },
  );
  assert.deepEqual(
    result.notifications[0].reply_markup?.inline_keyboard
      .flat()
      .map(({ callback_data }) => callback_data),
    watchdogN8nFixture.notifications.riskCallbackData,
  );
  assert.equal(result.notifications[0].review_id, 55);
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
      [{ id: "103" }],
      [
        {
          ...transaction,
          id: "103",
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
