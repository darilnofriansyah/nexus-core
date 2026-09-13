import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { SkipCoreApiKey } from "../../common/decorators/skip-core-api-key.decorator";
import { ok } from "../../common/dto/api-response.dto";
import { CreativeRepository } from "./creative.repository";
import { CreativeWorkerGuard } from "./creative-worker.guard";

const JOB_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

@Controller("rovelle/creative-jobs")
@SkipCoreApiKey()
@UseGuards(CreativeWorkerGuard)
export class CreativeController {
  constructor(private readonly repository: CreativeRepository) {}

  @Get()
  @HttpCode(HttpStatus.OK)
  async listQueued(@Query() query: unknown) {
    if (
      query === null ||
      typeof query !== "object" ||
      Array.isArray(query) ||
      Reflect.ownKeys(query).length !== 1 ||
      !Object.prototype.hasOwnProperty.call(query, "status") ||
      (query as Record<string, unknown>).status !== "QUEUED"
    ) {
      throw new BadRequestException("status must be QUEUED");
    }

    const jobs = await this.repository.listQueued(new Date());
    return ok({ jobs });
  }

  @Post(":id/claim")
  @HttpCode(HttpStatus.OK)
  async claim(@Param("id") id: string, @Body() body: unknown) {
    const jobId = validateJobId(id);
    validateEmptyClaimBody(body);
    return ok(await this.repository.claim(jobId, new Date()));
  }

  @Post(":id/result")
  @HttpCode(HttpStatus.OK)
  async complete(@Param("id") id: string, @Body() body: unknown) {
    const jobId = validateJobId(id);
    return ok(await this.repository.complete(jobId, body, new Date()));
  }
}

function validateJobId(value: string): string {
  if (!JOB_ID_PATTERN.test(value)) {
    throw new BadRequestException("job id must be a valid UUID");
  }
  return value;
}

function validateEmptyClaimBody(value: unknown): void {
  if (value === undefined) return;
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Reflect.ownKeys(value).length > 0
  ) {
    throw new BadRequestException("claim body must be empty");
  }
}
