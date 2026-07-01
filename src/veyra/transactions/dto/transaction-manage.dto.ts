import { TelegramReplyMarkupDto } from './confirmation-payload.dto';

export type TransactionManageStatus =
  | 'needs_selection'
  | 'needs_confirmation'
  | 'completed'
  | 'cancelled'
  | 'not_found'
  | 'invalid';

export type TransactionManageIntent =
  | 'edit_transaction'
  | 'delete_transaction'
  | 'cancel_action';

export type TransactionManageStateName =
  | 'select_transaction'
  | 'confirm_action'
  | 'idle';

export interface TransactionManageTargetDto {
  id?: string | number | null;
  merchant?: string | null;
  category?: string | null;
  amount?: number | string | null;
  period?: string | null;
}

export interface TransactionManageChangesDto {
  amount?: number | string | null;
  merchant?: string | null;
  merchant_normalized?: string | null;
  category?: string | null;
  transaction_date?: string | null;
  transaction_type?: string | null;
  notes?: string | null;
}

export interface TransactionManageLlmResultDto {
  intent?: TransactionManageIntent | string;
  target?: TransactionManageTargetDto | null;
  changes?: TransactionManageChangesDto | null;
  selection?: unknown;
  confidence?: number;
}

export interface TransactionManageHandleRequestDto {
  telegramUserId: string;
  text?: string;
  statePayload?: unknown;
  llmResult?: TransactionManageLlmResultDto | null;
}

export interface TransactionManageHandleResponseDto {
  ok: boolean;
  status: TransactionManageStatus;
  message: string;
  reply_markup: TelegramReplyMarkupDto | null;
  state: {
    state_name: TransactionManageStateName;
    state_data: Record<string, unknown>;
  };
  data: Record<string, unknown>;
}
