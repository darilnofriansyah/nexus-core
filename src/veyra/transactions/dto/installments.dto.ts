export interface InstallmentTerms {
  tenorMonths: number;
  monthlyRatePercent: string;
  firstDueDate: string;
}

export interface ScheduleRow {
  sequence: number;
  dueDate: string;
  principal: number;
  interest: number;
  total: number;
}

export interface InstallmentSchedule {
  items: ScheduleRow[];
  totalInterest: number;
  totalPayable: number;
}

export interface InstallmentRequest extends InstallmentTerms {
  telegramUserId: string | number;
  expectedUpdatedAt: string;
}

export interface InstallmentPreview extends InstallmentSchedule {
  originalTransactionId: string;
  originalUpdatedAt: string;
  principal: number;
  timezone: string;
  terms: InstallmentTerms;
}

export interface InstallmentPlan extends InstallmentPreview {
  planId: string;
}
