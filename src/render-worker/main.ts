import { NestFactory } from "@nestjs/core";

import { RenderWorkerModule } from "./render-worker.module";
import { RenderWorkerService } from "./render-worker.service";

export async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(RenderWorkerModule);
  const worker = app.get(RenderWorkerService);
  let signalCount = 0;

  const onSignal = (): void => {
    signalCount++;
    if (signalCount === 1) {
      worker.requestShutdown();
      return;
    }
    process.exit(1);
  };

  process.once("SIGTERM", onSignal);
  process.once("SIGINT", onSignal);
  try {
    await worker.run();
  } finally {
    process.off("SIGTERM", onSignal);
    process.off("SIGINT", onSignal);
    await app.close();
  }
}

void bootstrap().catch(() => {
  process.exitCode = 1;
});
