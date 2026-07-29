import {
  Injectable,
  Logger,
  Optional,
  ServiceUnavailableException,
} from "@nestjs/common";
import OpenAI from "openai";
import { readEnv } from "../config/env";
import { ManualTransactionLlmResultDto } from "../veyra/transactions/dto/handle-transaction.dto";
import {
  MANUAL_TRANSACTION_INSTRUCTIONS,
  MANUAL_TRANSACTION_MODEL,
  MANUAL_TRANSACTION_PROMPT_VERSION,
  MANUAL_TRANSACTION_SCHEMA,
} from "./veyra-prompts";

const RESULT_KEYS = [
  "intent",
  "transaction_type",
  "amount",
  "merchant",
  "category",
  "wallet",
  "notes",
  "missing_fields",
  "confidence",
] as const;

const MISSING_FIELDS = ["amount", "merchant", "category"];

export interface ExtractTransactionInput {
  text: string;
  allowedCategories: string[];
}

@Injectable()
export class VeyraAiService {
  private readonly logger = new Logger(VeyraAiService.name);
  private client?: OpenAI;

  constructor(@Optional() client?: OpenAI) {
    this.client = client;
  }

  async extractTransaction(
    input: ExtractTransactionInput,
  ): Promise<ManualTransactionLlmResultDto> {
    const startedAt = Date.now();
    let responseId: string | undefined;
    let inputTokens: number | undefined;
    let outputTokens: number | undefined;

    try {
      const signal = AbortSignal.timeout(readEnv().openAiTimeoutMs);
      const response = await Promise.race([
        this.getClient().responses.create(
          {
            model: MANUAL_TRANSACTION_MODEL,
            store: false,
            input: [
              { role: "developer", content: MANUAL_TRANSACTION_INSTRUCTIONS },
              {
                role: "user",
                content: JSON.stringify({
                  message: input.text,
                  allowed_categories: input.allowedCategories,
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
          { signal },
        ),
        new Promise<never>((_, reject) =>
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          }),
        ),
      ]);

      responseId = response.id;
      inputTokens = response.usage?.input_tokens;
      outputTokens = response.usage?.output_tokens;

      if (
        response.status !== "completed" ||
        this.hasRefusal(response.output) ||
        !response.output_text.trim()
      ) {
        throw new Error("Invalid response");
      }

      const result = this.parseTransactionResult(response.output_text);
      this.logResult({
        responseId,
        latencyMs: Date.now() - startedAt,
        inputTokens,
        outputTokens,
        validation: "passed",
      });
      return result;
    } catch {
      this.logResult({
        responseId,
        latencyMs: Date.now() - startedAt,
        inputTokens,
        outputTokens,
        validation: "failed",
      });
      throw new ServiceUnavailableException("AI transaction extraction failed");
    }
  }

  private getClient(): OpenAI {
    if (this.client) return this.client;

    const env = readEnv();

    if (!env.openAiApiKey) {
      throw new ServiceUnavailableException(
        "AI transaction extraction is unavailable",
      );
    }

    this.client = new OpenAI({
      apiKey: env.openAiApiKey,
      logLevel: "off",
      timeout: env.openAiTimeoutMs,
      maxRetries: 2,
    });
    return this.client;
  }

  private parseTransactionResult(
    output: string,
  ): ManualTransactionLlmResultDto {
    let parsed: unknown;

    try {
      parsed = JSON.parse(output);
    } catch {
      throw new Error("Invalid JSON");
    }

    if (!this.isPlainRecord(parsed)) throw new Error("Invalid result");

    const keys = Object.keys(parsed);
    if (
      keys.length !== RESULT_KEYS.length ||
      !RESULT_KEYS.every((key) =>
        Object.prototype.hasOwnProperty.call(parsed, key),
      )
    ) {
      throw new Error("Invalid result");
    }

    if (
      !["record_transaction", "reset", "unknown"].includes(
        parsed.intent as string,
      )
    ) {
      throw new Error("Invalid intent");
    }

    if (
      parsed.transaction_type !== null &&
      !["expense", "income", "transfer"].includes(
        parsed.transaction_type as string,
      )
    ) {
      throw new Error("Invalid transaction type");
    }

    if (
      parsed.amount !== null &&
      (typeof parsed.amount !== "number" ||
        !Number.isFinite(parsed.amount) ||
        parsed.amount <= 0)
    ) {
      throw new Error("Invalid amount");
    }

    if (
      !this.isNullableString(parsed.merchant) ||
      !this.isNullableString(parsed.category) ||
      !this.isNullableString(parsed.wallet) ||
      !this.isNullableString(parsed.notes)
    ) {
      throw new Error("Invalid text field");
    }

    if (
      !Array.isArray(parsed.missing_fields) ||
      parsed.missing_fields.some(
        (field) => typeof field !== "string" || !MISSING_FIELDS.includes(field),
      ) ||
      new Set(parsed.missing_fields).size !== parsed.missing_fields.length
    ) {
      throw new Error("Invalid missing fields");
    }

    if (
      typeof parsed.confidence !== "number" ||
      !Number.isFinite(parsed.confidence) ||
      parsed.confidence < 0 ||
      parsed.confidence > 1
    ) {
      throw new Error("Invalid confidence");
    }

    return parsed as ManualTransactionLlmResultDto;
  }

  private hasRefusal(output: unknown): boolean {
    if (!Array.isArray(output)) return false;

    return output.some((item) => {
      if (!this.isPlainRecord(item) || !Array.isArray(item.content))
        return false;
      return item.content.some(
        (content) => this.isPlainRecord(content) && content.type === "refusal",
      );
    });
  }

  private isPlainRecord(value: unknown): value is Record<string, unknown> {
    return (
      typeof value === "object" &&
      value !== null &&
      Object.getPrototypeOf(value) === Object.prototype
    );
  }

  private isNullableString(value: unknown): value is string | null {
    return value === null || typeof value === "string";
  }

  private logResult(input: {
    responseId: string | undefined;
    latencyMs: number;
    inputTokens: number | undefined;
    outputTokens: number | undefined;
    validation: "passed" | "failed";
  }): void {
    this.logger.log({
      capability: "transaction-extract",
      model: MANUAL_TRANSACTION_MODEL,
      promptVersion: MANUAL_TRANSACTION_PROMPT_VERSION,
      ...input,
    });
  }
}
