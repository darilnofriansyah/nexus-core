export interface CreateRenderRequestDto {
  requestId: string;
  audioAssetId: string;
  captionAssetId?: string | null;
}

export interface RetryRenderRequestDto {
  requestId: string;
}
