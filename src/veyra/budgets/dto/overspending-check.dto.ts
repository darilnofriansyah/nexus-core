export type OverspendingAlertType =
  | 'overspend_80'
  | 'overspend_100'
  | 'overspend_120';

export type OverspendingHandleStatus =
  | 'no_alert'
  | 'already_alerted'
  | 'alert_required';

export type OverspendingRecordStatus = 'recorded' | 'already_recorded';

export interface OverspendingTelegramMessageDto {
  text: string;
  parse_mode: 'HTML';
  disable_web_page_preview: true;
}

export interface OverspendingAlertRecordDto {
  userId: string;
  budgetId: string;
  alertType: OverspendingAlertType;
  thresholdPercent: number;
  periodKey: string;
}

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

export interface OverspendingHandleRequestDto {
  userId: string | number;
  category: string;
  transactionId?: string | number | null;
  asOfDate?: string | null;
}

export interface OverspendingHandleResponseDto {
  ok: true;
  status: OverspendingHandleStatus;
  shouldAlert: boolean;
  alreadyAlerted: boolean;
  message: OverspendingTelegramMessageDto | null;
  data: {
    transactionId?: string | number | null;
    userId: string;
    budgetId?: string;
    category: string;
    alertType?: OverspendingAlertType;
    thresholdPercent?: number;
    periodKey?: string;
    spentPercent?: number;
    spentAmount?: number;
    budgetAmount?: number;
    remainingAmount?: number;
    cycleStart?: string;
    cycleEnd?: string;
    alertRecord?: OverspendingAlertRecordDto;
  };
}

export interface OverspendingRecordRequestDto {
  userId: string | number;
  budgetId: string | number;
  alertType: OverspendingAlertType;
  thresholdPercent?: number | null;
  periodKey: string;
}

export interface OverspendingRecordResponseDto {
  ok: true;
  status: OverspendingRecordStatus;
  data: OverspendingAlertRecordDto;
}
