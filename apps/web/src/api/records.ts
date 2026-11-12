import type { RecordDecisionPayload } from "@hobbots/api";
import type {
  Artifact,
  ArtifactReviewOutcome,
  Decision,
  DecisionId,
  HobbotsEvent,
  RegisteredArtifactId,
  ThreadId,
} from "@hobbots/domain";
import { type QueryClient, queryOptions, useMutation, useQueryClient } from "@tanstack/react-query";
import { ApiError, call } from "./client.ts";
import { followsEvents } from "./queries.ts";

// A chat's or camp's records (ADR 037), as the camp sheet shows them: its decisions, its artifacts at
// their latest version and its brief, each as the hub keeps it. Their events read the list again.

export const recordKeys = {
  decisions: (threadId: ThreadId) => ["threads", threadId, "decisions"] as const,
  artifacts: (threadId: ThreadId) => ["threads", threadId, "artifacts"] as const,
  brief: (threadId: ThreadId) => ["threads", threadId, "brief"] as const,
};

/** The thread's decisions, newest first, crossed-out ones kept. */
export const decisionsQuery = (threadId: ThreadId) =>
  queryOptions({
    queryKey: recordKeys.decisions(threadId),
    queryFn: () => call((c) => c.records.decisions({ params: { threadId } })),
    ...followsEvents,
  });

/** One row per artifact at its latest version, the most recently changed first. */
export const artifactsQuery = (threadId: ThreadId) =>
  queryOptions({
    queryKey: recordKeys.artifacts(threadId),
    queryFn: () => call((c) => c.records.artifacts({ params: { threadId } })),
    ...followsEvents,
  });

/** The "Where we are" the hub writes, or null before it first writes one. */
export const briefQuery = (threadId: ThreadId) =>
  queryOptions({
    queryKey: recordKeys.brief(threadId),
    queryFn: () => call((c) => c.records.brief({ params: { threadId } })),
    ...followsEvents,
  });

/**
 * Reads a thread's list again after its event. A read already on its way may predate the change, so
 * it is cancelled first (STD-REACT-012).
 */
export const readListAgain = async (queryClient: QueryClient, queryKey: ReadonlyArray<unknown>): Promise<void> => {
  await queryClient.cancelQueries({ queryKey, exact: true });
  await queryClient.invalidateQueries({ queryKey, exact: true });
};

type RecordEvent = Extract<
  HobbotsEvent,
  {
    readonly _tag:
      | "DecisionRecorded"
      | "DecisionSuperseded"
      | "ArtifactRegistered"
      | "ArtifactReviewSettled"
      | "BriefWritten";
  }
>;
const RECORD_EVENTS: ReadonlySet<HobbotsEvent["_tag"]> = new Set([
  "DecisionRecorded",
  "DecisionSuperseded",
  "ArtifactRegistered",
  "ArtifactReviewSettled",
  "BriefWritten",
]);
export const isRecordEvent = (event: HobbotsEvent): event is RecordEvent => RECORD_EVENTS.has(event._tag);

/** A decision, an artifact or a brief changed (ADR 037): its list is read again. */
export const applyRecordEvent = (queryClient: QueryClient, event: RecordEvent): Promise<void> => {
  switch (event._tag) {
    case "DecisionRecorded":
    case "DecisionSuperseded":
      return readListAgain(queryClient, recordKeys.decisions(event.decision.threadId));
    case "ArtifactRegistered":
    case "ArtifactReviewSettled":
      return readListAgain(queryClient, recordKeys.artifacts(event.artifact.threadId));
    case "BriefWritten":
      return readListAgain(queryClient, recordKeys.brief(event.brief.threadId));
  }
};

/** Puts the decisions the hub answered in the list, each in place of the copy it held. */
const takeDecisions = (queryClient: QueryClient, threadId: ThreadId, changed: ReadonlyArray<Decision>) =>
  queryClient.setQueryData<ReadonlyArray<Decision>>(recordKeys.decisions(threadId), (old) => {
    if (old === undefined) return old;
    const fresh = changed.filter((decision) => !old.some((each) => each.id === decision.id));
    const replaced = old.map((each) => changed.find((decision) => decision.id === each.id) ?? each);
    return [...fresh, ...replaced];
  });

/** Records a decision of yours, replacing `replaces` when it changes one; `key` records it once. */
export const useRecordDecision = (threadId: ThreadId) => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: RecordDecisionPayload) =>
      call((c) => c.records.recordDecision({ params: { threadId }, payload })),
    onSuccess: ({ recorded, superseded }) =>
      takeDecisions(queryClient, threadId, superseded === null ? [recorded] : [recorded, superseded]),
  });
};

/** Crosses a decision out: it stays, no longer holding. */
export const useCrossOutDecision = (threadId: ThreadId) => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (decisionId: DecisionId) =>
      call((c) => c.records.crossOutDecision({ params: { threadId, decisionId } })),
    onSuccess: (decision) => takeDecisions(queryClient, threadId, [decision]),
  });
};

/** Why a review was not saved: the hub refused it (already settled the other way), or it was not reached. */
export type ReviewArtifactError = "refused" | "unreachable";

export const reviewArtifactError = (error: unknown): ReviewArtifactError =>
  error instanceof ApiError && error.tag === "ArtifactReviewChangeRefused" ? "refused" : "unreachable";

/**
 * Marks an artifact reviewed or dismisses it (#1422), once: the hub answers the artifact as it now
 * stands, which takes its place in the list.
 */
export const useReviewArtifact = (threadId: ThreadId) => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      artifactId,
      outcome,
    }: {
      readonly artifactId: RegisteredArtifactId;
      readonly outcome: ArtifactReviewOutcome;
    }) => call((c) => c.records.reviewArtifact({ params: { threadId, artifactId }, payload: { outcome } })),
    onSuccess: (artifact) =>
      queryClient.setQueryData<ReadonlyArray<Artifact>>(recordKeys.artifacts(threadId), (old) =>
        old?.map((each) => (each.id === artifact.id ? artifact : each)),
      ),
  });
};
