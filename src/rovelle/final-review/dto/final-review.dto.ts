import type { RovelleEpisodeStatus } from '../../../generated/prisma/client';
import type { AssetReadUrlDto } from '../../assets/dto/asset.dto';
import type { RenderDto } from '../../render/render-mapper';

export interface SubmitFinalRenderReviewRequestDto {
  requestId: string;
  decision: "APPROVE" | "REJECT" | "RERENDER";
  notes?: string | null;
}

export interface FinalRenderReviewDto {
  id: string;
  requestId: string;
  renderId: string;
  reviewerType: "HUMAN";
  decision: "APPROVE" | "REJECT" | "RERENDER";
  notes: string | null;
  createdAt: string;
}

export interface FinalRenderRerenderActionDto {
  type: "CREATE_RENDER";
  endpoint: string;
  defaults: {
    audioAssetId: string;
    captionAssetId: string | null;
  };
}

export interface FinalReviewQueueItemDto {
  episode: {
    id: string;
    code: string;
    title: string;
    status: "FINAL_REVIEW";
  };
  render: RenderDto;
  reviews: FinalRenderReviewDto[];
  preview: AssetReadUrlDto["download"];
}

export interface ApprovedFinalMasterDto {
  episode: {
    id: string;
    code: string;
    title: string;
    status: RovelleEpisodeStatus;
    approvedRenderId: string;
  };
  render: RenderDto;
  read: AssetReadUrlDto["download"];
}
