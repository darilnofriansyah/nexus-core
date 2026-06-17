export interface ApiResponse<TData> {
  ok: boolean;
  data: TData;
}

export function ok<TData>(data: TData): ApiResponse<TData> {
  return { ok: true, data };
}

