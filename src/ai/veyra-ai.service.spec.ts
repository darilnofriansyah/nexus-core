import * as assert from "node:assert/strict";
import { test } from "node:test";
import { ServiceUnavailableException } from "@nestjs/common";
import OpenAI from "openai";
import {
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

function clientFor(response: unknown): OpenAI {
  return {
    responses: {
      create: async () => response,
    },
  } as unknown as OpenAI;
}

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

test("maps refusal, incomplete, empty, timeout, and API failures to 503", async () => {
  const cases: Array<unknown | Error> = [
    {
      status: "completed",
      output_text: JSON.stringify(validResult),
      output: [{ type: "message", content: [{ type: "refusal" }] }],
    },
    { status: "incomplete", output_text: JSON.stringify(validResult) },
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
