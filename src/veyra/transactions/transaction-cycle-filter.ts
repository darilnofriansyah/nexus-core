import { WebTransactionsFilter } from "./dto/web-transactions.dto";

interface Month {
  year: number;
  month: number;
}

export function addTransactionCycleBounds(
  filter: Pick<
    WebTransactionsFilter,
    "cycle" | "asOfDate" | "startDate" | "endDate"
  >,
  cycleStartDay: number,
): void {
  if (filter.cycle === null) return;
  const [year, month] = filter.asOfDate.split("-").map(Number);
  const thisMonth = { year, month };
  const day = Math.min(Math.max(Math.trunc(cycleStartDay), 1), 31);
  const currentMonth =
    filter.asOfDate >= monthBoundary(thisMonth, day)
      ? thisMonth
      : shiftMonth(thisMonth, -1);
  const startMonth =
    filter.cycle === "previous" ? shiftMonth(currentMonth, -1) : currentMonth;
  filter.startDate = monthBoundary(startMonth, day);
  filter.endDate = monthBoundary(shiftMonth(startMonth, 1), day);
}

function monthBoundary({ year, month }: Month, cycleStartDay: number): string {
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days =
    month === 2 ? (leap ? 29 : 28) : [4, 6, 9, 11].includes(month) ? 30 : 31;
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(Math.min(cycleStartDay, days)).padStart(2, "0")}`;
}

function shiftMonth(month: Month, offset: number): Month {
  const index = month.year * 12 + month.month - 1 + offset;
  return {
    year: Math.floor(index / 12),
    month: (((index % 12) + 12) % 12) + 1,
  };
}
