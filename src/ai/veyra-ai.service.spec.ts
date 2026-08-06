import * as assert from "node:assert/strict";
import { test } from "node:test";
import { ServiceUnavailableException } from "@nestjs/common";
import OpenAI from "openai";
import {
  EMAIL_TRANSACTION_INSTRUCTIONS,
  EMAIL_TRANSACTION_SCHEMA,
  MANUAL_TRANSACTION_INSTRUCTIONS,
  MANUAL_TRANSACTION_SCHEMA,
} from "./veyra-prompts";
import { VeyraAiService } from "./veyra-ai.service";

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
      model: "gpt-5-mini",
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
      model: "gpt-4.1-mini",
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
