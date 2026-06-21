import { Body, Controller, Post } from '@nestjs/common';
import {
  RouteVeyraMessageRequestDto,
  RouteVeyraMessageResponseDto,
} from './dto/message-route.dto';
import { VeyraMessageRouteService } from './message-route.service';

@Controller('veyra/messages')
export class VeyraMessagesController {
  constructor(private readonly messageRouteService: VeyraMessageRouteService) {}

  @Post('route')
  routeMessage(
    @Body() body: RouteVeyraMessageRequestDto,
  ): Promise<RouteVeyraMessageResponseDto> {
    return this.messageRouteService.routeMessage(body);
  }
}
