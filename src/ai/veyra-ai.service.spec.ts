import * as assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { ServiceUnavailableException } from "@nestjs/common";
import OpenAI from "openai";
import {
  EMAIL_TRANSACTION_INSTRUCTIONS,
  EMAIL_TRANSACTION_SCHEMA,
  MANUAL_TRANSACTION_INSTRUCTIONS,
  MANUAL_TRANSACTION_SCHEMA,
  MASTER_INTENT_INSTRUCTIONS,
  MASTER_INTENT_MODEL,
  MASTER_INTENT_SCHEMA,
  MASTER_INTENTS,
} from "./veyra-prompts";
import type { MasterIntentResultDto } from "../veyra/messages/dto/message-route.dto";
import type { ConversationalInsightPayloadDto } from "../veyra/conversational/dto/conversational-handle.dto";
import { ClassifyMasterIntentInput, VeyraAiService } from "./veyra-ai.service";

const validResult = {
  intent: "record_transaction",
  transaction_type: "expense",
  amount: 25000,
  merchant: "Tuku",
  category: "Coffee",
  wallet: null,
  notes: "Spend 25k at Tuku",
  missing_fields: [],
  confidence: 0.94,
};

const validBudgetIntentResult = {
  intent: "set_sub_budget",
  category: "Netflix",
  parent_category: "Subscription",
  amount: 37200,
  missing_fields: [],
};

const analyticsInsightPayload: ConversationalInsightPayloadDto = {
  intent: "spending_summary",
  user_text: "how much did I spend?",
  period: { label: "current_cycle", start: "2026-07-25", end: "2026-08-25" },
  comparison_period: null,
  facts: { total: 125000, transaction_count: 3 },
  rules: ["Use only these numbers."],
};

const weeklyReviewPayload: ConversationalInsightPayloadDto = {
  ...analyticsInsightPayload,
  intent: "weekly_spending_review",
  facts: {
    weekly_spending: 3941794,
    transaction_count: 7,
    week_comparison: { current_week: 3941794, previous_week: 3000000, pct_change: 31.4 },
  },
};

const validWeeklyReviewResult = {
  rating: "neutral",
  insights: [
    "Spending rose sharply from last week.",
    "Bills and Bibit account for much of the total.",
    "Transaction activity remained limited.",
  ],
  verdict: "This week was uneven. Keep an eye on concentration.",
};

const validEmailResult = {
  isTransaction: true,
  transactionCandidate: {
    source: "email",
    bank: "Krom",
    transactionType: "expense",
    amount: 25000,
    merchant: "Kopi Tuku",
    merchantNormalized: "Kopi Tuku",
    transactionDate: "2026-07-27T09:30:00+07:00",
    rawPayload: {},
  },
  resolution: {
    category: "Food",
    confidence: 0.98,
    resolver: "llm",
  },
  templateProposal: null,
};

const validMasterIntentResult = {
  intent: "spending_summary",
  period: "this_month",
  merchant: null,
  category: null,
  limit: null,
  target: {
    id: null,
    merchant: null,
    category: null,
    amount: null,
    period: null,
  },
  changes: {
    amount: null,
    merchant: null,
    merchant_normalized: null,
    category: null,
    transaction_date: null,
    transaction_type: null,
    notes: null,
  },
  selection: null,
  confidence: 0.97,
};

type FixtureExpected = Partial<
  Omit<MasterIntentResultDto, "target" | "changes">
> & {
  target?: Partial<MasterIntentResultDto["target"]>;
  changes?: Partial<MasterIntentResultDto["changes"]>;
};

const masterIntentFixture = JSON.parse(
  readFileSync(
    join(
      process.cwd(),
      "src/ai/test/fixtures/master-intent/n8n-classifier.json",
    ),
    "utf8",
  ),
) as {
  evidence: {
    workflowId: string;
    workflowVersionId: string;
    model: string;
    liveOutputsCaptured: boolean;
  };
  defaults: MasterIntentResultDto;
  cases: Array<{
    name: string;
    input: ClassifyMasterIntentInput;
    expected: FixtureExpected;
  }>;
};

function expectedFixtureResult(expected: FixtureExpected) {
  return {
    ...masterIntentFixture.defaults,
    ...expected,
    target: {
      ...masterIntentFixture.defaults.target,
      ...expected.target,
    },
    changes: {
      ...masterIntentFixture.defaults.changes,
      ...expected.changes,
    },
  } satisfies MasterIntentResultDto;
}

function clientFor(response: unknown): OpenAI {
  return {
    responses: {
      create: async () => response,
    },
  } as unknown as OpenAI;
}

test("disables SDK logging even when OPENAI_LOG is debug", () => {
  const previousApiKey = process.env.OPENAI_API_KEY;
  const previousLogLevel = process.env.OPENAI_LOG;
  process.env.OPENAI_API_KEY = "test-key";
  process.env.OPENAI_LOG = "debug";

  try {
    const client = (
      new VeyraAiService() as unknown as { getClient(): OpenAI }
    ).getClient();

    assert.equal(client.logLevel, "off");
  } finally {
    if (previousApiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousApiKey;
    if (previousLogLevel === undefined) delete process.env.OPENAI_LOG;
    else process.env.OPENAI_LOG = previousLogLevel;
  }
});

test("uses OPENAI_TIMEOUT_MS as the overall request deadline", async () => {
  const previousTimeout = process.env.OPENAI_TIMEOUT_MS;
  const signals: Array<AbortSignal | null | undefined> = [];
  process.env.OPENAI_TIMEOUT_MS = "5";

  const client = {
    responses: {
      create: async (
        _request: unknown,
        options?: { signal?: AbortSignal | null },
      ) => {
        signals.push(options?.signal);
        await new Promise((resolve) => setTimeout(resolve, 50));
        return {
          status: "completed",
          output_text: JSON.stringify(validResult),
        };
      },
    },
  } as unknown as OpenAI;

  try {
    await assert.rejects(
      new VeyraAiService(client).extractTransaction({
        text: "private Telegram message",
        allowedCategories: [],
      }),
      ServiceUnavailableException,
    );
    const [signal] = signals;
    assert.ok(signal);
    assert.equal(signal.aborted, true);
  } finally {
    if (previousTimeout === undefined) delete process.env.OPENAI_TIMEOUT_MS;
    else process.env.OPENAI_TIMEOUT_MS = previousTimeout;
  }
});

test("extracts a valid manual transaction with a stateless strict-schema request", async () => {
  const requests: unknown[] = [];
  const client = {
    responses: {
      create: async (request: unknown) => {
        requests.push(request);
        return {
          id: "resp_123",
          status: "completed",
          output_text: JSON.stringify(validResult),
          usage: { input_tokens: 10, output_tokens: 20 },
        };
      },
    },
  } as unknown as OpenAI;

  const result = await new VeyraAiService(client).extractTransaction({
    text: "Spend 25k at Tuku",
    allowedCategories: ["Coffee", "Food"],
  });

  assert.deepEqual(result, validResult);
  assert.deepEqual(requests, [
    {
      model: "gpt-5.6-luna",
      store: false,
      input: [
        { role: "developer", content: MANUAL_TRANSACTION_INSTRUCTIONS },
        {
          role: "user",
          content: JSON.stringify({
            message: "Spend 25k at Tuku",
            allowed_categories: ["Coffee", "Food"],
          }),
        },
      ],
      text: {
        format: {
          type: "json_schema",
          name: "manual_transaction",
          strict: true,
          schema: MANUAL_TRANSACTION_SCHEMA,
        },
      },
    },
  ]);
});

test("parses a budget intent with the preserved stateless strict-schema contract", async () => {
  const requests: unknown[] = [];
  const client = {
    responses: {
      create: async (request: unknown) => {
        requests.push(request);
        return {
          id: "resp_budget_123",
          status: "completed",
          output_text: JSON.stringify(validBudgetIntentResult),
          usage: { input_tokens: 8, output_tokens: 12 },
        };
      },
    },
  } as unknown as OpenAI;

  const service = new VeyraAiService(client) as unknown as {
    parseBudgetIntent(input: unknown): Promise<unknown>;
  };
  const result = await service.parseBudgetIntent({
    text: "Netflix under Subscription 37200",
    statePayload: {},
  });

  assert.deepEqual(result, validBudgetIntentResult);
  const [request] = requests as Array<{
    model: string;
    store: boolean;
    input: Array<{ role: string; content: string }>;
    text: {
      format: {
        type: string;
        name: string;
        strict: boolean;
        schema: { required: string[] };
      };
    };
  }>;
  assert.equal(request.model, "gpt-5.6-luna");
  assert.equal(request.store, false);
  assert.match(request.input[0].content, /budget intent parser/);
  assert.deepEqual(JSON.parse(request.input[1].content), {
    text: "Netflix under Subscription 37200",
    statePayload: {},
  });
  assert.deepEqual(request.text.format, {
    type: "json_schema",
    name: "budget_intent",
    strict: true,
    schema: request.text.format.schema,
  });
  assert.deepEqual(request.text.format.schema.required, [
    "intent",
    "category",
    "parent_category",
    "amount",
    "missing_fields",
  ]);
});

test("rejects malformed budget intent output without exposing the message", async () => {
  await assert.rejects(
    new VeyraAiService(
      clientFor({
        status: "completed",
        output_text: JSON.stringify({ ...validBudgetIntentResult, extra: true }),
      }),
    ).parseBudgetIntent({
      text: "private budget text",
      statePayload: {},
    }),
    (error: unknown) => {
      assert.ok(error instanceof ServiceUnavailableException);
      assert.equal(error.getStatus(), 503);
      assert.equal(error.message, "AI budget intent parsing failed");
      assert.doesNotMatch(error.message, /private budget text/);
      return true;
    },
  );
});

test("renders analytics insight with stateless strict-schema contract", async () => {
  const requests: unknown[] = [];
  const client = {
    responses: {
      create: async (request: unknown) => {
        requests.push(request);
        return {
          id: "resp_insight_123",
          status: "completed",
          output_text: JSON.stringify({ text: "• Total spending: Rp125.000." }),
          usage: { input_tokens: 8, output_tokens: 12 },
        };
      },
    },
  } as unknown as OpenAI;

  const result = await new VeyraAiService(client).renderAnalyticsInsight(
    analyticsInsightPayload,
  );

  assert.equal(result, "• Total spending: Rp125.000.");
  const [request] = requests as Array<{
    model: string;
    store: boolean;
    input: Array<{ role: string; content: string }>;
    text: { format: { type: string; name: string; strict: boolean } };
  }>;
  assert.equal(request.model, "gpt-5.6-luna");
  assert.equal(request.store, false);
  assert.match(request.input[0].content, /analytics insight renderer/);
  assert.deepEqual(JSON.parse(request.input[1].content), analyticsInsightPayload);
  assert.equal(request.text.format.type, "json_schema");
  assert.equal(request.text.format.name, "analytics_insight");
  assert.equal(request.text.format.strict, true);
});

test("rejects unsafe analytics insight output", async () => {
  await assert.rejects(
    new VeyraAiService(
      clientFor({
        status: "completed",
        output_text: JSON.stringify({ text: "<b>Invented</b>" }),
      }),
    ).renderAnalyticsInsight(analyticsInsightPayload),
    (error: unknown) => {
      assert.ok(error instanceof ServiceUnavailableException);
      assert.equal(error.getStatus(), 503);
      assert.equal(error.message, "AI analytics insight rendering failed");
      return true;
    },
  );
});

test("renders weekly review with stateless strict-schema contract", async () => {
  const requests: unknown[] = [];
  const client = {
    responses: {
      create: async (request: unknown) => {
        requests.push(request);
        return {
          id: "resp_weekly_123",
          status: "completed",
          output_text: JSON.stringify(validWeeklyReviewResult),
        };
      },
    },
  } as unknown as OpenAI;

  assert.deepEqual(
    await new VeyraAiService(client).renderWeeklyReview(weeklyReviewPayload),
    validWeeklyReviewResult,
  );
  const [request] = requests as Array<{
    model: string;
    store: boolean;
    input: Array<{ role: string; content: string }>;
    text: { format: { name: string; strict: boolean } };
  }>;
  assert.equal(request.model, "gpt-5.6-terra");
  assert.equal(request.store, false);
  assert.match(request.input[0].content, /weekly review renderer/);
  assert.deepEqual(JSON.parse(request.input[1].content), weeklyReviewPayload);
  assert.equal(request.text.format.name, "weekly_review");
  assert.equal(request.text.format.strict, true);
});

test("rejects malformed weekly review output", async () => {
  await assert.rejects(
    new VeyraAiService(
      clientFor({
        status: "completed",
        output_text: JSON.stringify({
          ...validWeeklyReviewResult,
          insights: validWeeklyReviewResult.insights.slice(0, 2),
        }),
      }),
    ).renderWeeklyReview(weeklyReviewPayload),
    (error: unknown) => {
      assert.ok(error instanceof ServiceUnavailableException);
      assert.equal(error.getStatus(), 503);
      assert.equal(error.message, "AI weekly review rendering failed");
      return true;
    },
  );
});

test("reviews an email with the preserved stateless strict-schema contract", async () => {
  const requests: unknown[] = [];
  const client = {
    responses: {
      create: async (request: unknown) => {
        requests.push(request);
        return {
          id: "resp_email_123",
          status: "completed",
          output_text: JSON.stringify(validEmailResult),
          usage: { input_tokens: 30, output_tokens: 40 },
        };
      },
    },
  } as unknown as OpenAI;
  const input = {
    email: {
      messageId: "gmail-1",
      from: "alerts@krom.id",
      subject: "Pembayaran berhasil",
      date: "2026-07-27T09:30:00+07:00",
      emailText: "Pembayaran QR berhasil di Kopi Tuku sebesar Rp25.000",
      authentication: {
        dkim: "pass" as const,
        spf: "pass" as const,
        dmarc: "pass" as const,
        domain: "krom.id",
      },
    },
    aiRequest: {
      reviewToken: "gmail-1",
      reason: "unsupported_template" as const,
    },
  };

  const result = await new VeyraAiService(client).reviewEmailTransaction(input);

  assert.deepEqual(result, validEmailResult);
  assert.doesNotMatch(
    JSON.stringify(requests[0]),
    /"(?:uniqueItems|maxProperties)"/,
  );
  assert.deepEqual(requests, [
    {
      model: "gpt-5.6-luna",
      store: false,
      input: [
        { role: "developer", content: EMAIL_TRANSACTION_INSTRUCTIONS },
        { role: "user", content: JSON.stringify(input) },
      ],
      text: {
        format: {
          type: "json_schema",
          name: "email_transaction_review",
          strict: true,
          schema: EMAIL_TRANSACTION_SCHEMA,
        },
      },
    },
  ]);
});

test("classifies master intent with the audited stateless strict-schema contract", async () => {
  const requests: unknown[] = [];
  const client = {
    responses: {
      create: async (request: unknown) => {
        requests.push(request);
        return {
          id: "resp_master_123",
          status: "completed",
          output_text: JSON.stringify(validMasterIntentResult),
          usage: { input_tokens: 12, output_tokens: 24 },
        };
      },
    },
  } as unknown as OpenAI;

  const result = await new VeyraAiService(client).classifyMasterIntent({
    message: "How much did I spend?",
    currentState: null,
    stateData: {},
  });

  assert.deepEqual(result, validMasterIntentResult);
  assert.deepEqual(requests, [
    {
      model: "gpt-5.6-luna",
      store: false,
      input: [
        { role: "developer", content: MASTER_INTENT_INSTRUCTIONS },
        {
          role: "user",
          content: JSON.stringify({
            message: "How much did I spend?",
            current_state: null,
            state_data: {},
          }),
        },
      ],
      text: {
        format: {
          type: "json_schema",
          name: "master_intent",
          strict: true,
          schema: MASTER_INTENT_SCHEMA,
        },
      },
    },
  ]);
});

test("sanitized n8n fixture covers and validates every audited master intent", async () => {
  assert.equal(masterIntentFixture.evidence.model, MASTER_INTENT_MODEL);
  assert.equal(masterIntentFixture.evidence.liveOutputsCaptured, false);
  assert.deepEqual(
    masterIntentFixture.cases.map(({ expected }) => expected.intent).sort(),
    [...MASTER_INTENTS].sort(),
  );

  for (const fixture of masterIntentFixture.cases) {
    const expected = expectedFixtureResult(fixture.expected);
    const service = new VeyraAiService(
      clientFor({
        id: `fixture_${fixture.name}`,
        status: "completed",
        output_text: JSON.stringify(expected),
      }),
    );

    assert.deepEqual(
      await service.classifyMasterIntent(fixture.input),
      expected,
      fixture.name,
    );
  }
});

test("rejects malformed and refused master-intent output without exposing input", async () => {
  const privateMessage = "private Telegram 976684739";
  const cases = [
    {
      status: "completed",
      output_text: JSON.stringify({ ...validMasterIntentResult, extra: true }),
    },
    {
      status: "completed",
      output_text: JSON.stringify({
        ...validMasterIntentResult,
        intent: "invented_intent",
      }),
    },
    {
      status: "completed",
      output_text: JSON.stringify({
        ...validMasterIntentResult,
        target: { ...validMasterIntentResult.target, extra: true },
      }),
    },
    {
      status: "completed",
      output_text: JSON.stringify({
        ...validMasterIntentResult,
        changes: {
          ...validMasterIntentResult.changes,
          transaction_type: "refund",
        },
      }),
    },
    {
      status: "completed",
      output_text: JSON.stringify({ ...validMasterIntentResult, selection: 0 }),
    },
    {
      status: "completed",
      output_text: JSON.stringify({
        ...validMasterIntentResult,
        confidence: 2,
      }),
    },
    { status: "completed", output_text: "{" },
    {
      status: "completed",
      output_text: JSON.stringify(validMasterIntentResult),
      output: [{ type: "message", content: [{ type: "refusal" }] }],
    },
  ];

  for (const response of cases) {
    await assert.rejects(
      new VeyraAiService(clientFor(response)).classifyMasterIntent({
        message: privateMessage,
        currentState: null,
        stateData: {},
      }),
      (error: unknown) => {
        assert.ok(error instanceof ServiceUnavailableException);
        assert.equal(error.getStatus(), 503);
        assert.equal(error.message, "AI master intent classification failed");
        assert.doesNotMatch(error.message, /976684739/);
        return true;
      },
    );
  }
});

test("times out master-intent inference and logs metadata only", async () => {
  const previousTimeout = process.env.OPENAI_TIMEOUT_MS;
  const logged: unknown[] = [];
  process.env.OPENAI_TIMEOUT_MS = "5";
  const client = {
    responses: {
      create: async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
        return {
          status: "completed",
          output_text: JSON.stringify(validMasterIntentResult),
        };
      },
    },
  } as unknown as OpenAI;
  const service = new VeyraAiService(client);
  (service as unknown as { logger: { log(value: unknown): void } }).logger = {
    log: (value) => logged.push(value),
  };

  try {
    await assert.rejects(
      service.classifyMasterIntent({
        message: "private Telegram 976684739",
        currentState: null,
        stateData: {},
      }),
      ServiceUnavailableException,
    );
    assert.match(JSON.stringify(logged), /master-intent/);
    assert.doesNotMatch(JSON.stringify(logged), /private Telegram|976684739/);
  } finally {
    if (previousTimeout === undefined) delete process.env.OPENAI_TIMEOUT_MS;
    else process.env.OPENAI_TIMEOUT_MS = previousTimeout;
  }
});

test("rejects malformed email AI output without exposing email content", async () => {
  const privateEmail = "private card digits 4111111111111111";
  const malformed = [
    { ...validEmailResult, extra: true },
    { ...validEmailResult, transactionCandidate: null },
    {
      isTransaction: false,
      transactionCandidate: validEmailResult.transactionCandidate,
      resolution: null,
      templateProposal: null,
    },
  ];

  for (const result of malformed) {
    await assert.rejects(
      new VeyraAiService(
        clientFor({ status: "completed", output_text: JSON.stringify(result) }),
      ).reviewEmailTransaction({
        email: {
          messageId: "gmail-private",
          from: "alerts@krom.id",
          subject: "Private",
          emailText: privateEmail,
        },
        aiRequest: {
          reviewToken: "gmail-private",
          reason: "unsupported_template",
        },
      }),
      (error: unknown) => {
        assert.ok(error instanceof ServiceUnavailableException);
        assert.equal(error.getStatus(), 503);
        assert.equal(error.message, "AI email transaction review failed");
        assert.doesNotMatch(error.message, /4111/);
        return true;
      },
    );
  }
});

test("rejects malformed structured output without exposing input data", async () => {
  const malformed = [
    JSON.stringify({ ...validResult, transaction_type: "refund" }),
    JSON.stringify({ ...validResult, amount: 0 }),
    JSON.stringify({ ...validResult, amount: -1 }),
    JSON.stringify({ ...validResult, amount: "not-a-number" }),
    JSON.stringify({ ...validResult, confidence: 1.01 }),
    JSON.stringify({ ...validResult, extra: true }),
    JSON.stringify({
      intent: validResult.intent,
      transaction_type: validResult.transaction_type,
      amount: validResult.amount,
      merchant: validResult.merchant,
      category: validResult.category,
      wallet: validResult.wallet,
      notes: validResult.notes,
      missing_fields: validResult.missing_fields,
    }),
    '{"intent":"record_transaction","transaction_type":"expense","amount":1e999,"merchant":null,"category":null,"wallet":null,"notes":null,"missing_fields":[],"confidence":0.5}',
  ];

  for (const output of malformed) {
    const service = new VeyraAiService(
      clientFor({ status: "completed", output_text: output }),
    );

    await assert.rejects(
      service.extractTransaction({
        text: "private Telegram message",
        allowedCategories: [],
      }),
      (error: unknown) => {
        assert.ok(error instanceof ServiceUnavailableException);
        assert.equal(error.getStatus(), 503);
        assert.equal(error.message, "AI transaction extraction failed");
        assert.doesNotMatch(error.message, /private Telegram message/);
        return true;
      },
    );
  }
});

test("maps syntactically invalid JSON output to 503", async () => {
  await assert.rejects(
    new VeyraAiService(
      clientFor({ status: "completed", output_text: "{" }),
    ).extractTransaction({
      text: "private Telegram message",
      allowedCategories: [],
    }),
    (error: unknown) => {
      assert.ok(error instanceof ServiceUnavailableException);
      assert.equal(error.getStatus(), 503);
      return true;
    },
  );
});

test("maps refusal and non-completed responses to 503", async () => {
  const cases: Array<unknown | Error> = [
    {
      status: "completed",
      output_text: JSON.stringify(validResult),
      output: [{ type: "message", content: [{ type: "refusal" }] }],
    },
    { status: "incomplete", output_text: JSON.stringify(validResult) },
    { status: "failed", output_text: JSON.stringify(validResult) },
    { status: "cancelled", output_text: JSON.stringify(validResult) },
    { status: "queued", output_text: JSON.stringify(validResult) },
    { status: "in_progress", output_text: JSON.stringify(validResult) },
    { status: "completed", output_text: "" },
    new Error("request timed out"),
    new Error("OpenAI API failed"),
  ];

  for (const response of cases) {
    const client = {
      responses: {
        create: async () => {
          if (response instanceof Error) throw response;
          return response;
        },
      },
    } as unknown as OpenAI;

    await assert.rejects(
      new VeyraAiService(client).extractTransaction({
        text: "private Telegram message",
        allowedCategories: [],
      }),
      (error: unknown) => {
        assert.ok(error instanceof ServiceUnavailableException);
        assert.equal(error.getStatus(), 503);
        assert.equal(error.message, "AI transaction extraction failed");
        return true;
      },
    );
  }
});
