import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import {
  TimelineCursor,
  TimelineFilter,
  TimelinePage,
  TimelineQueryRequest,
  TimelineRow,
} from "./dto/transaction-timeline.dto";
import {
  WEB_TRANSACTION_MAX_CURSOR_LENGTH,
  WEB_TRANSACTION_MAX_TEXT_LENGTH,
} from "./dto/web-transactions.dto";
import { addTransactionCycleBounds } from "./transaction-cycle-filter";
import { TransactionTimelineRepository } from "./transaction-timeline.repository";
import { WebTransactionsRepository } from "./web-transactions.repository";
import {
  isPositivePostgresBigint,
  isValidMicrosecondUtcTimestamp,
  toPublicWebTransactionCategories,
} from "./web-transaction-public-contract";

const QUERY_KEYS = new Set([
  "telegramUserId",
  "month",
  "cycle",
  "asOfDate",
  "timezone",
  "type",
  "category",
  "merchantQuery",
  "limit",
  "cursor",
  "direction",
]);

@Injectable()
export class TransactionTimelineService {
  constructor(
    private readonly repository: TransactionTimelineRepository,
    private readonly users: WebTransactionsRepository,
  ) {}

  async query(request: TimelineQueryRequest): Promise<TimelinePage> {
    if (
      !request ||
      typeof request !== "object" ||
      Array.isArray(request) ||
      Object.keys(request).some((key) => !QUERY_KEYS.has(key))
    ) {
      throw new BadRequestException("query contains unsupported fields");
    }
    const id = request.telegramUserId;
    const telegramUserId =
      typeof id === "number" && Number.isSafeInteger(id)
        ? String(id)
        : typeof id === "string"
          ? id.trim()
          : "";
    if (telegramUserId.length > 19 || !isPositivePostgresBigint(telegramUserId))
      throw new BadRequestException(
        "telegramUserId must be a positive integer",
      );
    const filter = this.filter(request);
    const user = await this.users.findActiveUserByTelegramId(telegramUserId);
    if (!user) throw new NotFoundException("Telegram user not found");
    addTransactionCycleBounds(filter, user.cycleStartDay);
    const categoryFilter = { ...filter };
    delete categoryFilter.category;
    delete categoryFilter.cursor;
    delete categoryFilter.direction;
    delete categoryFilter.limit;
    const { cursor, direction, limit } = filter;
    const [rows, categories] = await Promise.all([
      this.repository.findEntries(user.id, filter),
      this.repository.findCategories(user.id, categoryFilter),
    ]);
    const hasExtra = rows.length > limit;
    const displayed = rows.slice(0, limit);
    if (direction === "previous") displayed.reverse();
    const hasCursor = cursor !== null && displayed.length > 0;
    return {
      items: displayed.map((row) => row.entry),
      previousCursor: (direction === "previous" ? hasExtra : hasCursor)
        ? this.cursorFor(displayed[0])
        : null,
      nextCursor: (direction === "previous" ? hasCursor : hasExtra)
        ? this.cursorFor(displayed.at(-1))
        : null,
      categories: toPublicWebTransactionCategories(categories),
    };
  }

  private filter(request: TimelineQueryRequest): TimelineFilter {
    const timezone =
      request.timezone == null
        ? "Asia/Jakarta"
        : typeof request.timezone === "string"
          ? request.timezone.trim()
          : "";
    let today: string;
    try {
      const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: timezone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).formatToParts(new Date());
      today = ["year", "month", "day"]
        .map((type) => parts.find((part) => part.type === type)?.value)
        .join("-");
    } catch {
      throw new BadRequestException("timezone must be valid");
    }
    const asOfDate =
      request.asOfDate == null
        ? today
        : this.text(request.asOfDate, "asOfDate");
    if (
      !asOfDate ||
      !isValidMicrosecondUtcTimestamp(`${asOfDate}T00:00:00.000000Z`)
    )
      throw new BadRequestException("asOfDate must be a valid date");
    const limit = request.limit ?? 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > 50)
      throw new BadRequestException("limit must be an integer from 1 to 50");
    const cursor = this.cursor(request.cursor);
    const direction = this.enumValue(request.direction, ["next", "previous"]);
    const filter: TimelineFilter = {
      cursor,
      direction: cursor ? (direction ?? "next") : "next",
      limit,
      timezone,
      asOfDate,
      startDate: null,
      endDate: null,
      cycle: this.enumValue(request.cycle, ["current", "previous"]),
      type: this.enumValue(request.type, ["income", "expense"]),
      category: this.text(request.category, "category"),
      merchantQuery: this.text(request.merchantQuery, "merchantQuery"),
    };
    const month = this.text(request.month, "month");
    if (month !== null) {
      if (filter.cycle !== null)
        throw new BadRequestException("month and cycle cannot be combined");
      if (
        !/^\d{4}-\d{2}$/.test(month) ||
        !isValidMicrosecondUtcTimestamp(`${month}-01T00:00:00.000000Z`)
      )
        throw new BadRequestException("month must be YYYY-MM");
      const [year, number] = month.split("-").map(Number);
      filter.startDate = `${month}-01`;
      filter.endDate = `${String(number === 12 ? year + 1 : year).padStart(4, "0")}-${String(number === 12 ? 1 : number + 1).padStart(2, "0")}-01`;
    }
    return filter;
  }

  private text(value: unknown, name: string): string | null {
    if (value == null) return null;
    if (
      typeof value !== "string" ||
      !value.trim() ||
      value.trim().length > WEB_TRANSACTION_MAX_TEXT_LENGTH
    )
      throw new BadRequestException(`${name} must be valid`);
    return value.trim();
  }

  private enumValue<T extends string>(
    value: unknown,
    allowed: readonly T[],
  ): T | null {
    if (value == null) return null;
    if (typeof value !== "string" || !allowed.includes(value as T))
      throw new BadRequestException("filter must be valid");
    return value as T;
  }

  private cursor(value: unknown): TimelineCursor | null {
    if (value == null) return null;
    try {
      if (
        typeof value !== "string" ||
        !value.length ||
        value.length > WEB_TRANSACTION_MAX_CURSOR_LENGTH ||
        !/^[A-Za-z0-9_-]+$/.test(value)
      )
        throw new Error();
      const buffer = Buffer.from(value, "base64url");
      if (buffer.toString("base64url") !== value) throw new Error();
      const payload: unknown = JSON.parse(buffer.toString("utf8"));
      if (!payload || typeof payload !== "object" || Array.isArray(payload))
        throw new Error();
      const record = payload as Record<string, unknown>;
      if (
        Object.keys(record).sort().join(",") !== "at,id,kind,v" ||
        record.v !== 1 ||
        (record.kind !== 0 && record.kind !== 1) ||
        typeof record.id !== "string" ||
        record.id.length > 19 ||
        !isPositivePostgresBigint(record.id) ||
        typeof record.at !== "string" ||
        !isValidMicrosecondUtcTimestamp(record.at)
      )
        throw new Error();
      return record as unknown as TimelineCursor;
    } catch {
      throw new BadRequestException("cursor must be valid");
    }
  }

  private cursorFor(row: TimelineRow | undefined): string | null {
    return row
      ? Buffer.from(
          JSON.stringify({
            v: 1,
            at: row.sortAt,
            kind: row.kindRank,
            id: row.rowId,
          } satisfies TimelineCursor),
        ).toString("base64url")
      : null;
  }
}
