import { Module } from "@nestjs/common";

import { PrismaModule } from "../database/prisma.module";
import { AssetsModule } from "../rovelle/assets/assets.module";
import { FfmpegRunner } from "./ffmpeg-runner";
import { FfprobeService } from "./ffprobe.service";
import { MediaTransferService } from "./media-transfer.service";
import { RenderJobProcessor } from "./render-job.processor";
import { RenderWorkerRepository } from "./render-worker.repository";
import {
  RENDER_WORKER_CONFIG,
  RENDER_WORKER_SLEEP,
  RenderWorkerService,
  renderWorkerSleep,
} from "./render-worker.service";
import { TempWorkspaceService } from "./temp-workspace.service";
import { readRenderWorkerConfig } from "./worker-config";

@Module({
  imports: [PrismaModule, AssetsModule],
  providers: [
    {
      provide: RENDER_WORKER_CONFIG,
      useFactory: readRenderWorkerConfig,
    },
    {
      provide: TempWorkspaceService,
      useFactory: (config: ReturnType<typeof readRenderWorkerConfig>) =>
        new TempWorkspaceService(config),
      inject: [RENDER_WORKER_CONFIG],
    },
    {
      provide: FfmpegRunner,
      useFactory: (config: ReturnType<typeof readRenderWorkerConfig>) =>
        new FfmpegRunner(config),
      inject: [RENDER_WORKER_CONFIG],
    },
    {
      provide: FfprobeService,
      useFactory: (config: ReturnType<typeof readRenderWorkerConfig>) =>
        new FfprobeService(config),
      inject: [RENDER_WORKER_CONFIG],
    },
    {
      provide: RENDER_WORKER_SLEEP,
      useValue: renderWorkerSleep,
    },
    RenderWorkerRepository,
    MediaTransferService,
    {
      provide: RenderJobProcessor,
      useFactory: (
        repository: RenderWorkerRepository,
        workspaceService: TempWorkspaceService,
        mediaTransfer: MediaTransferService,
        ffmpegRunner: FfmpegRunner,
        ffprobeService: FfprobeService,
        config: ReturnType<typeof readRenderWorkerConfig>,
      ) =>
        new RenderJobProcessor(
          repository,
          workspaceService,
          mediaTransfer,
          ffmpegRunner,
          ffprobeService,
          {
            leaseSeconds: config.leaseSeconds,
            heartbeatSeconds: config.heartbeatSeconds,
          },
        ),
      inject: [
        RenderWorkerRepository,
        TempWorkspaceService,
        MediaTransferService,
        FfmpegRunner,
        FfprobeService,
        RENDER_WORKER_CONFIG,
      ],
    },
    RenderWorkerService,
  ],
})
export class RenderWorkerModule {}
