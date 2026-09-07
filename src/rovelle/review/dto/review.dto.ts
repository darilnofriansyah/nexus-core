export interface SubmitHumanReviewRequestDto {
  requestId: string;
  decision: "APPROVE" | "REJECT" | "REGENERATE";
  notes?: string | null;
}

export interface GenerationReviewResultDto {
  review: {
    id: string;
    requestId: string;
    generationId: string;
    reviewerType: "HUMAN";
    decision: "APPROVE" | "REJECT" | "REGENERATE";
    notes: string | null;
    createdAt: string;
  };
  generation: { id: string; status: string };
  shot: { id: string; status: string; approvedGenerationId: string | null };
  episode: { id: string; status: string };
}
