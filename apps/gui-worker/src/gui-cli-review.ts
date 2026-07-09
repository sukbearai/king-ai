export type GuiCliReviewRecord = {
  id: string;
  capsuleId: string;
  decision: string;
  reasons: string[];
  createdAt: number;
};

export type GuiCliReviewCapsule = {
  id: string;
  status: string;
  updated_at: number;
};

export type GuiCliReviewMergeRequest = {
  id: string;
  status: string;
  updatedAt: number;
};

export type RunReviewCommandDeps<S extends { reviews: GuiCliReviewRecord[] }, R extends GuiCliReviewRecord> = {
  findReview: (state: S, id: string | undefined) => R | undefined;
  findCapsule: (state: S, id: string | undefined) => GuiCliReviewCapsule | undefined;
  findMergeRequest: (state: S, id: string | undefined) => GuiCliReviewMergeRequest | undefined;
  parseReviewRecord: (args: string[], capsule: GuiCliReviewCapsule) => R;
  formatReviewLine: (review: R) => string;
  readOption: (args: string[], flag: string) => string | undefined;
};

export function runReviewCommand<S extends { reviews: GuiCliReviewRecord[] }, R extends GuiCliReviewRecord>(
  state: S,
  args: string[],
  deps: RunReviewCommandDeps<S, R>,
): string {
  const cmd = args[0] || "list";
  if (cmd === "list") {
    const decision = deps.readOption(args, "--decision");
    const reviewer = deps.readOption(args, "--reviewer");
    const capsuleId = deps.readOption(args, "--capsule");
    const rows = state.reviews.filter(
      (review) =>
        (!decision || review.decision === decision) &&
        (!reviewer || (review as { reviewer?: string }).reviewer === reviewer) &&
        (!capsuleId || review.capsuleId === capsuleId || review.capsuleId.startsWith(capsuleId)),
    ) as R[];
    if (rows.length === 0) return "No reviews found.";
    return rows.map((review) => deps.formatReviewLine(review)).join("\n") + `\n\n${rows.length} review(s)`;
  }
  if (cmd === "get") {
    const review = deps.findReview(state, args[1]);
    return review ? JSON.stringify(review, null, 2) : `review not found: ${args[1] || ""}`;
  }
  if (cmd === "record") {
    const capsule = deps.findCapsule(state, deps.readOption(args, "--capsule"));
    if (!capsule) {
      return "usage: king-ai review record --capsule <id> --coverage <pct> [--checks true|false] [--acceptance true|false] [--scope true|false] [--tests true|false] [--regressions true|false]";
    }
    const review = deps.parseReviewRecord(args, capsule);
    state.reviews.push(review);
    if (review.decision === "approved") {
      capsule.status = "in_review";
      capsule.updated_at = review.createdAt;
      const merge = deps.findMergeRequest(state, deps.readOption(args, "--merge"));
      if (merge && merge.status === "queued") {
        merge.status = "testing";
        merge.updatedAt = review.createdAt;
      }
    }
    return `review recorded ${review.id} capsule=${review.capsuleId} decision=${review.decision}${review.reasons.length ? ` reasons=${review.reasons.join("; ")}` : ""}`;
  }
  return "usage: king-ai review record|list|get [--capsule id] [--coverage pct] [--checks true|false]";
}
