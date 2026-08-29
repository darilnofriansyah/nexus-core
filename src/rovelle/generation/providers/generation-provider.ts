export const GENERATION_PROVIDER = Symbol("GENERATION_PROVIDER");

export interface GenerationProviderSubmission {
  taskId: string;
  prompt: string;
  duration: number;
  width: number;
  height: number;
  referenceImageUrls: string[];
  uploadUrl: string;
}

export interface GenerationProviderSubmissionResult {
  providerTaskId: string;
}

export interface GenerationProvider {
  submit(
    request: GenerationProviderSubmission,
  ): Promise<GenerationProviderSubmissionResult>;
}
