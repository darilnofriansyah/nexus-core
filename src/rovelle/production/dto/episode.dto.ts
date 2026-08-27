export interface CreateEpisodeRequestDto {
  code: string;
  title: string;
  targetDurationSeconds?: number | null;
}

export interface UpdateEpisodeBriefRequestDto {
  brief: Record<string, unknown>;
}

export interface ShotInputDto {
  sequence: number;
  name?: string | null;
  direction: string;
  targetDurationSeconds?: number | null;
}

export interface ReplaceEpisodeShotsRequestDto {
  shots: ShotInputDto[];
}
