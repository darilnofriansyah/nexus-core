export interface SubmitHumanReviewRequestDto {
  requestId: string;
  decision: "APPROVE" | "REJECT" | "REGENERATE";
  notes?: string | null;
}
