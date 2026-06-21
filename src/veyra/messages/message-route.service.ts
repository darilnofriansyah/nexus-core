import { BadRequestException, Injectable } from '@nestjs/common';
import {
  RouteVeyraMessageRequestDto,
  RouteVeyraMessageResponseDto,
  VeyraMessageRoute,
  VeyraMessageRouteReason,
  VeyraMessageRouteStateDto,
} from './dto/message-route.dto';
import {
  VeyraMessageRouteRepository,
  VeyraMessageRouteState,
  VeyraMessageRouteUser,
} from './message-route.repository';

@Injectable()
export class VeyraMessageRouteService {
  constructor(private readonly repository: VeyraMessageRouteRepository) {}

  async routeMessage(
    request: RouteVeyraMessageRequestDto,
  ): Promise<RouteVeyraMessageResponseDto> {
    const telegramUserId = this.normalizeOptionalString(request.telegramUserId);
    const requestUserId = this.normalizeOptionalNumericString(request.userId);
    const text = this.normalizeOptionalString(request.text);
    const messageType = this.normalizeOptionalString(request.messageType);

    if (!telegramUserId && !requestUserId) {
      throw new BadRequestException('telegramUserId or userId is required');
    }

    const user = await this.repository.findUser(requestUserId, telegramUserId);

    if (!user) {
      return this.buildResponse({
        route: 'fallback',
        reason: 'user_not_resolved',
        user: null,
        telegramUserId,
        text,
        messageType,
        command: null,
        state: null,
      });
    }

    if (request.callbackQuery !== null && request.callbackQuery !== undefined) {
      return this.buildResponse({
        route: 'callback',
        reason: 'callback_query',
        user,
        telegramUserId,
        text,
        messageType,
        command: null,
        state: null,
      });
    }

    const command = this.extractSlashCommand(text);

    if (command) {
      return this.buildResponse({
        route: 'slash_command',
        reason: 'slash_command',
        user,
        telegramUserId,
        text,
        messageType,
        command,
        state: null,
      });
    }

    const activeState = await this.repository.findActiveState(user.id);

    if (!activeState) {
      return this.buildResponse({
        route: 'conversational',
        reason: 'no_active_state',
        user,
        telegramUserId,
        text,
        messageType,
        command: null,
        state: null,
      });
    }

    const stateRoute = this.routeActiveState(activeState.name);

    return this.buildResponse({
      route: stateRoute.route,
      reason: stateRoute.reason,
      user,
      telegramUserId,
      text,
      messageType,
      command: null,
      state: {
        name: activeState.name ?? '',
        data: activeState.data ?? {},
      },
    });
  }

  private routeActiveState(stateName: string | null): {
    route: VeyraMessageRoute;
    reason: VeyraMessageRouteReason;
  } {
    if (stateName === 'budget_conversation_state') {
      return { route: 'budget', reason: 'active_budget_state' };
    }

    if (stateName === 'record_transaction_state') {
      return { route: 'record', reason: 'active_record_state' };
    }

    if (
      stateName === 'awaiting_confirmation' ||
      stateName === 'awaiting_transaction_selection'
    ) {
      return {
        route: 'transaction_edit',
        reason: 'active_transaction_edit_state',
      };
    }

    return { route: 'fallback', reason: 'unknown_active_state' };
  }

  private extractSlashCommand(text: string | null): string | null {
    const trimmed = text?.trim() ?? '';

    if (!trimmed.startsWith('/')) {
      return null;
    }

    return trimmed.split(/\s+/, 1)[0] || null;
  }

  private normalizeOptionalString(value: unknown): string | null {
    if (value === null || value === undefined) {
      return null;
    }

    const normalized = String(value).trim();

    return normalized || null;
  }

  private normalizeOptionalNumericString(value: unknown): string | null {
    const normalized = this.normalizeOptionalString(value);

    if (!normalized) {
      return null;
    }

    if (!/^\d+$/.test(normalized)) {
      throw new BadRequestException('userId must be numeric');
    }

    return normalized;
  }

  private buildResponse(input: {
    route: VeyraMessageRoute;
    reason: VeyraMessageRouteReason;
    user: VeyraMessageRouteUser | null;
    telegramUserId: string | null;
    text: string | null;
    messageType: string | null;
    command: string | null;
    state: VeyraMessageRouteStateDto | null;
  }): RouteVeyraMessageResponseDto {
    return {
      route: input.route,
      reason: input.reason,
      userId: input.user?.id ?? null,
      telegramUserId:
        input.telegramUserId ?? input.user?.telegramUserId ?? null,
      text: input.text,
      messageType: input.messageType,
      command: input.command,
      state: input.state,
    };
  }
}
