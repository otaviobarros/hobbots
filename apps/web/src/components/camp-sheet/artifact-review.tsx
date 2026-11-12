import type { Actor, Artifact, ThreadId } from "@hobbots/domain";
import { Button } from "@hobbots/ui/components/button";
import { reviewArtifactError, useReviewArtifact } from "../../api/records.ts";
import { formatAgo } from "../../lib/format.ts";
import { messages } from "./messages.ts";

const copy = messages.artifacts.review;

/** Who settled a review, as the sheet names them: you, GitHub, Hobbots or the hob. */
const whoOf = (actor: Actor, hobName: string): string => {
  if (actor.kind === "user") return copy.you;
  if (actor.kind === "hob") return hobName;
  return actor.id === "github" ? copy.github : copy.hub;
};

/** Where an artifact's review stands, in a line (#1422). */
export const reviewLine = (artifact: Artifact, hobName: string): string => {
  if (artifact.review === "waiting" || artifact.reviewedAt === null || artifact.reviewedBy === null) {
    return copy.waiting;
  }
  const said = { who: whoOf(artifact.reviewedBy, hobName), when: formatAgo(artifact.reviewedAt) };
  return artifact.review === "reviewed" ? copy.reviewed(said) : copy.dismissed(said);
};

/**
 * An artifact waiting for you, settled once (#1422): Mark reviewed, or Dismiss when you choose not
 * to review it. Either lowers what its Quest has ready for review.
 */
export function ReviewActions({ threadId, artifact }: { threadId: ThreadId; artifact: Artifact }) {
  const review = useReviewArtifact(threadId);
  if (artifact.review !== "waiting") return null;
  const settle = (outcome: "reviewed" | "dismissed") => review.mutate({ artifactId: artifact.id, outcome });
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap gap-2">
        <Button size="sm" disabled={review.isPending} onClick={() => settle("reviewed")}>
          {review.isPending && review.variables.outcome === "reviewed" ? copy.saving : copy.markReviewed}
        </Button>
        <Button variant="outline" size="sm" disabled={review.isPending} onClick={() => settle("dismissed")}>
          {review.isPending && review.variables.outcome === "dismissed" ? copy.saving : copy.dismiss}
        </Button>
      </div>
      {review.isError && (
        <p role="alert" className="m-0 text-meta text-rose">
          {reviewArtifactError(review.error) === "refused" ? copy.refused : copy.unreachable}
        </p>
      )}
    </div>
  );
}
