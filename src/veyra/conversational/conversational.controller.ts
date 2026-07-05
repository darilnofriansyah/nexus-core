import { Body, Controller, Post } from '@nestjs/common';
import {
  ConversationalHandleRequestDto,
  ConversationalHandleResponseDto,
} from './dto/conversational-handle.dto';
import { ConversationalService } from './conversational.service';

@Controller('veyra/conversational')
export class ConversationalController {
  constructor(private readonly conversationalService: ConversationalService) {}

  @Post('handle')
  handle(
    @Body() body: ConversationalHandleRequestDto,
  ): Promise<ConversationalHandleResponseDto> {
    return this.conversationalService.handle(body);
  }
}
