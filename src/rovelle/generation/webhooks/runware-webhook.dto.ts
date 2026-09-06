export type RunwareWebhookEvent =
  | {
      kind: "processing";
      taskId: string;
      progress: number | null;
    }
  | {
      kind: "success";
      taskId: string;
      providerOutputId: string | null;
      costUsd: string | null;
      videoUrl: string | null;
    }
  | {
      kind: "failure";
      taskId: string;
      code: string;
      message: string;
      costUsd: string | null;
    };
