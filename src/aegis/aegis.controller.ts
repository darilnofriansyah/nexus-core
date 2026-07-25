import { Body, Controller, Post } from "@nestjs/common";
import { AegisAlertFormatterService } from "./aegis-alert-formatter.service";
import {
  AegisN8nErrorAlertDto,
  AegisN8nErrorPayloadDto,
  AegisRetryCallbackRequestDto,
  AegisRetryCallbackResponseDto,
} from "./dto/aegis-error-alert.dto";

@Controller("aegis")
export class AegisController {
  constructor(private readonly formatter: AegisAlertFormatterService) {}

  @Post("n8n-error")
  formatN8nError(
    @Body() body: AegisN8nErrorPayloadDto | AegisN8nErrorPayloadDto[],
  ): AegisN8nErrorAlertDto {
    return this.formatter.formatN8nErrorAlert(body);
  }

  @Post("retry/handle")
  handleRetryCallback(
    @Body() body: AegisRetryCallbackRequestDto,
  ): AegisRetryCallbackResponseDto {
    return this.formatter.handleRetryCallback(body);
  }
}
