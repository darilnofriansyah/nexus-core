import { once } from "node:events";
import type { Server } from "node:http";

import {
  readExecutionServerConfig,
  readTransportConfig,
} from "./worker-config";

async function startTransport(): Promise<void> {
  const config = readTransportConfig();
  const [{ CompletionStore }, { createJobProcessor }, { createWorkerServer }] =
    await Promise.all([
      import("./completion-store"),
      import("./job-processor"),
      import("./worker-server"),
    ]);
  const store = new CompletionStore(
    config.spoolDirectory,
    config.spoolMaxBytes,
  );
  const processor = createJobProcessor({
    config: {
      n8nBaseUrl: config.n8nBaseUrl,
      executorBaseUrl: config.executorBaseUrl,
      callbackKey: config.callbackKey,
    },
    store,
    onError: (event) => process.stderr.write(`${event}\n`),
  });
  await processor.start();

  const server = createWorkerServer(config, processor);
  await listen(server, config.port, config.bindAddress);
  await waitForTransportShutdown(server, processor.shutdown);
}

async function startExecutor(): Promise<void> {
  const config = readExecutionServerConfig();
  const [{ executeStoryboard }, { createExecutionServer }] = await Promise.all([
    import("./codex-executor"),
    import("./execution-server"),
  ]);
  const server = createExecutionServer((request) =>
    executeStoryboard(request, config.worker),
  );
  await listen(server, config.port, config.bindAddress);
  await waitForExecutorShutdown(server);
}

async function listen(
  server: Server,
  port: number,
  host: string,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once("error", onError);
    server.listen(port, host, () => {
      server.off("error", onError);
      resolve();
    });
  });
}

async function waitForTransportShutdown(
  server: Server,
  stopProcessor: () => Promise<void>,
): Promise<void> {
  let shutdown: Promise<void> | undefined;
  const stop = (): Promise<void> => {
    if (shutdown) return shutdown;
    server.close();
    server.closeAllConnections();
    shutdown = stopProcessor();
    return shutdown;
  };
  const onSignal = (): void => {
    if (shutdown) {
      process.exit(1);
      return;
    }
    void stop();
  };

  process.once("SIGTERM", onSignal);
  process.once("SIGINT", onSignal);
  await once(server, "close");
  await stop();
  process.off("SIGTERM", onSignal);
  process.off("SIGINT", onSignal);
}

async function waitForExecutorShutdown(
  server: Server & { shutdown(): Promise<void> },
): Promise<void> {
  let stopping = false;
  const onSignal = (): void => {
    if (stopping) {
      process.exit(1);
      return;
    }
    stopping = true;
    void server.shutdown().finally(() => {
      // The Task 7 adapter has an execution timeout but no shutdown hook. Exiting
      // the isolated process kills any SDK child without recording a false result.
      process.exit(0);
    });
  };
  process.once("SIGTERM", onSignal);
  process.once("SIGINT", onSignal);
  await once(server, "close");
  process.off("SIGTERM", onSignal);
  process.off("SIGINT", onSignal);
}

async function bootstrap(): Promise<void> {
  if (process.argv[2] === "executor") {
    await startExecutor();
    return;
  }
  if (process.argv[2] !== "transport") {
    throw new Error("Specify the codex worker process role");
  }
  await startTransport();
}

if (require.main === module) {
  void bootstrap().catch(() => {
    process.exitCode = 1;
  });
}
