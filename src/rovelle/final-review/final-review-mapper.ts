import type {
  RovelleEpisode,
  RovelleRenderReview,
} from "../../generated/prisma/client";
import type {
  FinalRenderReviewDto,
  FinalRenderRerenderActionDto,
} from "./dto/final-review.dto";
import {
  toRenderDto,
  type RenderDto,
} from "../render/render-mapper";
import type { RenderSpecV1 } from "../render/render-spec";

type RenderRecord = Parameters<typeof toRenderDto>[0];

export interface FinalRenderReviewResultDto {
  review: FinalRenderReviewDto;
  render: RenderDto;
  nextAction: FinalRenderRerenderActionDto | null;
}

export interface FinalRenderReviewMappingInput {
  review: RovelleRenderReview;
  render: RenderRecord;
  episode: Pick<RovelleEpisode, "id">;
}

function mapReview(review: RovelleRenderReview): FinalRenderReviewDto {
  return {
    id: review.id,
    requestId: review.clientRequestId,
    renderId: review.renderId,
    reviewerType: "HUMAN",
    decision: review.decision,
    notes: review.notes,
    createdAt: review.createdAt.toISOString(),
  };
}

function mapNextAction(
  review: FinalRenderReviewDto,
  render: RenderRecord,
  episode: Pick<RovelleEpisode, "id">,
): FinalRenderRerenderActionDto | null {
  if (review.decision !== "RERENDER") return null;

  const spec = render.spec as unknown as RenderSpecV1;
  return {
    type: "CREATE_RENDER",
    endpoint: `/api/rovelle/episodes/${episode.id}/renders`,
    defaults: {
      audioAssetId: spec.audio.assetId,
      captionAssetId: spec.captions?.assetId ?? null,
    },
  };
}

export function toFinalRenderReviewDto(
  review: RovelleRenderReview,
): FinalRenderReviewDto {
  return mapReview(review);
}

export function toFinalRenderReviewResultDto(
  input: FinalRenderReviewMappingInput,
): FinalRenderReviewResultDto {
  const review = mapReview(input.review);

  return {
    review,
    render: toRenderDto(input.render),
    nextAction: mapNextAction(review, input.render, input.episode),
  };
}
