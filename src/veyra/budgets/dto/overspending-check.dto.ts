export type OverspendingAlertType =
  | 'overspend_80'
  | 'overspend_100'
  | 'overspend_120';

export interface OverspendingCheckRequestDto {
  userId: string;
  category: string;
}

export interface OverspendingCheckResponseDto {
  shouldAlert: boolean;
  alreadyAlerted: boolean;
  alertType: OverspendingAlertType | null;
  telegramHtml: string | null;
  alertRecord: {
    budgetId: string;
    alertType: OverspendingAlertType;
    periodKey: string;
  } | null;
  budgetId: string;
  userId: string;
  category: string;
  spentPercent: number;
  spentAmount: number;
  budgetAmount: number;
  remainingAmount: number;
  cycleStart: string;
  cycleEnd: string;
  periodKey: string;
}
