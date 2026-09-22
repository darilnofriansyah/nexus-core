import { BadRequestException } from "@nestjs/common";

import {
  InstallmentSchedule,
  InstallmentTerms,
  ScheduleRow,
} from "./dto/installments.dto";

const MAX_AMOUNT = 9_999_999_999_999n;
const INTEREST_DENOMINATOR = 1_000_000n;

export interface CanonicalInstallmentTerms {
  terms: InstallmentTerms;
  rateUnits: bigint;
}

export function canonicalizeInstallmentTerms(
  terms: InstallmentTerms,
): CanonicalInstallmentTerms {
  if (!Number.isInteger(terms.tenorMonths) || terms.tenorMonths < 1 || terms.tenorMonths > 120) {
    throw new BadRequestException("tenorMonths must be between 1 and 120");
  }

  const rate = /^(\d+)(?:\.(\d{1,4}))?$/.exec(terms.monthlyRatePercent);
  if (!rate) throw new BadRequestException("monthlyRatePercent must be a decimal percentage");
  const rateUnits = BigInt(rate[1]) * 10_000n + BigInt((rate[2] ?? "").padEnd(4, "0"));
  if (rateUnits > 1_000_000n) {
    throw new BadRequestException("monthlyRatePercent must not exceed 100");
  }

  const firstDueDate = parseDate(terms.firstDueDate);
  return {
    terms: {
      tenorMonths: terms.tenorMonths,
      monthlyRatePercent: formatRate(rateUnits),
      firstDueDate: formatDate(firstDueDate),
    },
    rateUnits,
  };
}

export function calculateInstallmentSchedule(
  principal: number,
  terms: InstallmentTerms,
): InstallmentSchedule {
  if (!Number.isSafeInteger(principal) || principal < 1 || BigInt(principal) > MAX_AMOUNT) {
    throw new BadRequestException("principal must be a safe whole IDR amount");
  }

  const canonical = canonicalizeInstallmentTerms(terms);
  const principalIdr = BigInt(principal);
  const tenor = BigInt(canonical.terms.tenorMonths);
  if (tenor > principalIdr) throw new BadRequestException("tenorMonths must not exceed principal");

  const regularPrincipal = principalIdr / tenor;
  const regularInterest = (principalIdr * canonical.rateUnits) / INTEREST_DENOMINATOR;
  const totalInterest =
    (principalIdr * canonical.rateUnits * tenor + INTEREST_DENOMINATOR / 2n) /
    INTEREST_DENOMINATOR;
  const totalPayable = principalIdr + totalInterest;
  if (totalInterest > MAX_AMOUNT || totalPayable > MAX_AMOUNT) {
    throw new BadRequestException("installment total exceeds the maximum IDR amount");
  }

  const finalPrincipal = principalIdr - regularPrincipal * (tenor - 1n);
  const finalInterest = totalInterest - regularInterest * (tenor - 1n);
  const firstDueDate = parseDate(canonical.terms.firstDueDate);
  const items: ScheduleRow[] = [];
  for (let sequence = 1; sequence <= canonical.terms.tenorMonths; sequence++) {
    const dueDate = addMonths(firstDueDate, sequence - 1);
    const rowPrincipal = sequence === canonical.terms.tenorMonths ? finalPrincipal : regularPrincipal;
    const interest = sequence === canonical.terms.tenorMonths ? finalInterest : regularInterest;
    const total = rowPrincipal + interest;
    if (total > MAX_AMOUNT) throw new BadRequestException("installment total exceeds the maximum IDR amount");
    items.push({
      sequence,
      dueDate: formatDate(dueDate),
      principal: Number(rowPrincipal),
      interest: Number(interest),
      total: Number(total),
    });
  }

  return { items, totalInterest: Number(totalInterest), totalPayable: Number(totalPayable) };
}

function parseDate(value: string): { year: number; month: number; day: number } {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) throw new BadRequestException("firstDueDate must be YYYY-MM-DD");
  const [year, month, day] = match.slice(1).map(Number);
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) {
    throw new BadRequestException("firstDueDate must be a real calendar date");
  }
  return { year, month, day };
}

function addMonths(date: { year: number; month: number; day: number }, offset: number) {
  const zeroBasedMonth = date.month - 1 + offset;
  const year = date.year + Math.floor(zeroBasedMonth / 12);
  const month = (zeroBasedMonth % 12) + 1;
  if (year > 9999) throw new BadRequestException("installment due date is out of range");
  return { year, month, day: Math.min(date.day, daysInMonth(year, month)) };
}

function daysInMonth(year: number, month: number): number {
  return month === 2 ? (year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28) : [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function formatDate({ year, month, day }: { year: number; month: number; day: number }): string {
  return `${year.toString().padStart(4, "0")}-${month.toString().padStart(2, "0")}-${day.toString().padStart(2, "0")}`;
}

function formatRate(rateUnits: bigint): string {
  const whole = rateUnits / 10_000n;
  const fraction = (rateUnits % 10_000n).toString().padStart(4, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}
