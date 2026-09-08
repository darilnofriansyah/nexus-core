import { Module } from "@nestjs/common";
import { AssetsModule } from "../assets/assets.module";
import { CanonModule } from "../canon/canon.module";
import { GenerationController } from "./generation.controller";
import { GenerationPreflightService } from "./generation-preflight.service";
import { GenerationPromptCompiler } from "./generation-prompt.compiler";
import { GenerationRepository } from "./generation.repository";
import { GenerationService } from "./generation.service";
import { RunwareWebhookController } from "./webhooks/runware-webhook.controller";
import { RunwareWebhookGuard } from "./webhooks/runware-webhook.guard";
import { RunwareWebhookService } from "./webhooks/runware-webhook.service";
import { GENERATION_PROVIDER } from "./providers/generation-provider";
import { RunwareSubmitClient } from "./providers/runware/runware-submit.client";
import { Vidu2Provider } from "./providers/runware/vidu-2.provider";

@Module({
  imports: [AssetsModule, CanonModule],
  controllers: [GenerationController, RunwareWebhookController],
  providers: [
    GenerationPromptCompiler,
    GenerationPreflightService,
    GenerationRepository,
    RunwareSubmitClient,
    Vidu2Provider,
    {
      provide: GENERATION_PROVIDER,
      useExisting: Vidu2Provider,
    },
    GenerationService,
    RunwareWebhookGuard,
    RunwareWebhookService,
  ],
  exports: [GenerationService, GenerationRepository, GenerationPreflightService],
})
export class GenerationModule {}
