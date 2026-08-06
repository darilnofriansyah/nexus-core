import {
  Injectable,
  Logger,
  Optional,
  ServiceUnavailableException,
} from "@nestjs/common";
import OpenAI from "openai";
import { readEnv } from "../config/env";
import {
  EmailAiHandoffDto,
  EmailParserTemplateProposalDto,
  EmailReviewResolutionDto,
  EmailReviewTransactionCandidateDto,
  EmailTransactionMessageDto,
} from "../veyra/transactions/dto/email-transaction.dto";
import { ManualTransactionLlmResultDto } from "../veyra/transactions/dto/handle-transaction.dto";
import {
  EMAIL_TRANSACTION_INSTRUCTIONS,
  EMAIL_TRANSACTION_MODEL,
  EMAIL_TRANSACTION_PROMPT_VERSION,
  EMAIL_TRANSACTION_SCHEMA,
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

export interface ReviewEmailTransactionInput {
  email: EmailTransactionMessageDto;
  aiRequest: EmailAiHandoffDto;
}

export type EmailAiReviewResult =
  | { isTransaction: false }
  | {
      isTransaction: true;
      transactionCandidate: EmailReviewTransactionCandidateDto;
      resolution: EmailReviewResolutionDto;
      templateProposal: EmailParserTemplateProposalDto | null;
    };

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
        capability: "transaction-extract",
        model: MANUAL_TRANSACTION_MODEL,
        promptVersion: MANUAL_TRANSACTION_PROMPT_VERSION,
        responseId,
        latencyMs: Date.now() - startedAt,
        inputTokens,
        outputTokens,
        validation: "passed",
      });
      return result;
    } catch {
      this.logResult({
        capability: "transaction-extract",
        model: MANUAL_TRANSACTION_MODEL,
        promptVersion: MANUAL_TRANSACTION_PROMPT_VERSION,
        responseId,
        latencyMs: Date.now() - startedAt,
        inputTokens,
        outputTokens,
        validation: "failed",
      });
      throw new ServiceUnavailableException("AI transaction extraction failed");
    }
  }

  async reviewEmailTransaction(
    input: ReviewEmailTransactionInput,
  ): Promise<EmailAiReviewResult> {
    const startedAt = Date.now();
    let responseId: string | undefined;
    let inputTokens: number | undefined;
    let outputTokens: number | undefined;

    try {
      const signal = AbortSignal.timeout(readEnv().openAiTimeoutMs);
      const response = await Promise.race([
        this.getClient().responses.create(
          {
            model: EMAIL_TRANSACTION_MODEL,
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

      const result = this.parseEmailReviewResult(response.output_text);
      this.logResult({
        capability: "email-transaction-review",
        model: EMAIL_TRANSACTION_MODEL,
        promptVersion: EMAIL_TRANSACTION_PROMPT_VERSION,
        responseId,
        latencyMs: Date.now() - startedAt,
        inputTokens,
        outputTokens,
        validation: "passed",
      });
      return result;
    } catch {
      this.logResult({
        capability: "email-transaction-review",
        model: EMAIL_TRANSACTION_MODEL,
        promptVersion: EMAIL_TRANSACTION_PROMPT_VERSION,
        responseId,
        latencyMs: Date.now() - startedAt,
        inputTokens,
        outputTokens,
        validation: "failed",
      });
      throw new ServiceUnavailableException(
        "AI email transaction review failed",
      );
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

  private parseEmailReviewResult(output: string): EmailAiReviewResult {
    const parsed = JSON.parse(output) as unknown;

    if (
      !this.hasExactKeys(parsed, [
        "isTransaction",
        "transactionCandidate",
        "resolution",
        "templateProposal",
      ])
    ) {
      throw new Error("Invalid email result");
    }

    if (parsed.isTransaction === false) {
      if (
        parsed.transactionCandidate !== null ||
        parsed.resolution !== null ||
        parsed.templateProposal !== null
      ) {
        throw new Error("Invalid non-transaction result");
      }
      return { isTransaction: false };
    }

    if (parsed.isTransaction !== true) {
      throw new Error("Invalid transaction result");
    }

    const transactionCandidate = this.parseEmailCandidate(
      parsed.transactionCandidate,
    );
    const resolution = this.parseEmailResolution(parsed.resolution);
    const templateProposal = this.parseEmailTemplateProposal(
      parsed.templateProposal,
    );

    return {
      isTransaction: true,
      transactionCandidate,
      resolution,
      templateProposal,
    };
  }

  private parseEmailCandidate(
    value: unknown,
  ): EmailReviewTransactionCandidateDto {
    const keys = [
      "source",
      "bank",
      "transactionType",
      "amount",
      "merchant",
      "merchantNormalized",
      "transactionDate",
      "rawPayload",
    ];
    if (!this.hasExactKeys(value, keys)) throw new Error("Invalid candidate");

    const transactionTypes = ["expense", "income", "transfer", "reversal"];
    if (
      value.source !== "email" ||
      !this.isNonEmptyString(value.bank) ||
      !transactionTypes.includes(value.transactionType as string) ||
      typeof value.amount !== "number" ||
      !Number.isFinite(value.amount) ||
      value.amount <= 0 ||
      !this.isNullableString(value.merchant) ||
      !this.isNullableString(value.merchantNormalized) ||
      !this.isNonEmptyString(value.transactionDate) ||
      !Number.isFinite(Date.parse(value.transactionDate)) ||
      !this.hasExactKeys(value.rawPayload, []) ||
      (value.transactionType === "expense" &&
        !this.isNonEmptyString(value.merchant))
    ) {
      throw new Error("Invalid candidate");
    }

    return value as unknown as EmailReviewTransactionCandidateDto;
  }

  private parseEmailResolution(value: unknown): EmailReviewResolutionDto {
    if (
      !this.hasExactKeys(value, ["category", "confidence", "resolver"]) ||
      !this.isNonEmptyString(value.category) ||
      typeof value.confidence !== "number" ||
      !Number.isFinite(value.confidence) ||
      value.confidence < 0 ||
      value.confidence > 1 ||
      value.resolver !== "llm"
    ) {
      throw new Error("Invalid resolution");
    }

    return value as unknown as EmailReviewResolutionDto;
  }

  private parseEmailTemplateProposal(
    value: unknown,
  ): EmailParserTemplateProposalDto | null {
    if (value === null) return null;
    if (
      !this.hasExactKeys(value, [
        "provider",
        "templateKey",
        "requiredAnchors",
        "forbiddenAnchors",
        "merchant",
        "amount",
        "transactionDate",
        "transactionType",
        "paymentType",
      ]) ||
      !this.isNonEmptyString(value.provider) ||
      !this.isNonEmptyString(value.templateKey) ||
      !this.isStringList(value.requiredAnchors, true) ||
      !this.isStringList(value.forbiddenAnchors, false) ||
      !["expense", "income", "transfer", "reversal"].includes(
        value.transactionType as string,
      ) ||
      !this.isNonEmptyString(value.paymentType)
    ) {
      throw new Error("Invalid template proposal");
    }

    const merchant = this.parseCaptureRule(value.merchant, "text");
    const amount = this.parseCaptureRule(value.amount, "idr_amount");
    const transactionDate = this.parseCaptureRule(
      value.transactionDate,
      "datetime",
    );

    return {
      provider: value.provider,
      templateKey: value.templateKey,
      requiredAnchors: value.requiredAnchors,
      forbiddenAnchors: value.forbiddenAnchors,
      merchant,
      amount,
      transactionDate,
      transactionType: value.transactionType,
      paymentType: value.paymentType,
    } as EmailParserTemplateProposalDto;
  }

  private parseCaptureRule(
    value: unknown,
    kind: "text" | "idr_amount" | "datetime",
  ): EmailParserTemplateProposalDto["amount"] {
    if (
      !this.hasExactKeys(value, ["kind", "after", "before"]) ||
      value.kind !== kind ||
      !this.isBoundedString(value.after, 200) ||
      (value.before !== null && !this.isBoundedString(value.before, 200))
    ) {
      throw new Error("Invalid capture rule");
    }

    return {
      kind,
      after: value.after,
      ...(value.before ? { before: value.before } : {}),
    };
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

  private isNonEmptyString(value: unknown): value is string {
    return typeof value === "string" && value.trim().length > 0;
  }

  private isBoundedString(value: unknown, maxLength: number): value is string {
    return this.isNonEmptyString(value) && value.length <= maxLength;
  }

  private isStringList(value: unknown, required: boolean): value is string[] {
    return (
      Array.isArray(value) &&
      (!required || value.length > 0) &&
      value.every((item) => this.isBoundedString(item, 200)) &&
      new Set(value).size === value.length
    );
  }

  private hasExactKeys(
    value: unknown,
    expectedKeys: readonly string[],
  ): value is Record<string, unknown> {
    return (
      this.isPlainRecord(value) &&
      Object.keys(value).length === expectedKeys.length &&
      expectedKeys.every((key) =>
        Object.prototype.hasOwnProperty.call(value, key),
      )
    );
  }

  private logResult(input: {
    capability: "transaction-extract" | "email-transaction-review";
    model: string;
    promptVersion: string;
    responseId: string | undefined;
    latencyMs: number;
    inputTokens: number | undefined;
    outputTokens: number | undefined;
    validation: "passed" | "failed";
  }): void {
    this.logger.log(input);
  }
}
