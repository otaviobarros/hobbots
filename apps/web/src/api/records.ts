import type { RecordDecisionPayload } from "@hobbots/api";
import {
  type Artifact,
  ArtifactContentRefusal,
  type ArtifactReviewOutcome,
  type ArtifactVersionContent,
  type Decision,
  type DecisionId,
  type HobbotsEvent,
  type RegisteredArtifactId,
  type ThreadId,
} from "@hobbots/domain";
import { type QueryClient, queryOptions, useMutation, useQueryClient } from "@tanstack/react-query";
import { Schema } from "effect";
import { API_URL, ApiError, call } from "./client.ts";
import { followsEvents } from "./queries.ts";

// A chat's or camp's records (ADR 037), as the camp sheet shows them: its decisions, its artifacts at
// their latest version and its brief, each as the hub keeps it. Their events read the list again.

export const recordKeys = {
  decisions: (threadId: ThreadId) => ["threads", threadId, "decisions"] as const,
  artifacts: (threadId: ThreadId) => ["threads", threadId, "artifacts"] as const,
  brief: (threadId: ThreadId) => ["threads", threadId, "brief"] as const,
  /** One artifact's versions and their contents, under one key so a new version reads them again. */
  artifact: (threadId: ThreadId, artifactId: RegisteredArtifactId) =>
    ["threads", threadId, "artifact", artifactId] as const,
  versions: (threadId: ThreadId, artifactId: RegisteredArtifactId) =>
    [...recordKeys.artifact(threadId, artifactId), "versions"] as const,
  content: (threadId: ThreadId, artifactId: RegisteredArtifactId, version: number) =>
    [...recordKeys.artifact(threadId, artifactId), "content", version] as const,
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

/** An artifact's versions, newest first, and how it is shown (#1434). */
export const artifactVersionsQuery = (threadId: ThreadId, artifactId: RegisteredArtifactId) =>
  queryOptions({
    queryKey: recordKeys.versions(threadId, artifactId),
    queryFn: () => call((c) => c.records.artifactVersions({ params: { threadId, artifactId } })),
    ...followsEvents,
  });

/**
 * One version's contents as the hub serves them: text redacted and cut, an image as it is. What the
 * hub kept never changes, so it is never read again; the latest version read from the file now is
 * read again with the artifact. A refusal is an answer, not a failure to retry.
 */
export const artifactContentQuery = (
  threadId: ThreadId,
  artifactId: RegisteredArtifactId,
  version: number,
  content: ArtifactVersionContent | "unknown",
) =>
  queryOptions({
    queryKey: recordKeys.content(threadId, artifactId, version),
    queryFn: () => call((c) => c.records.artifactContent({ params: { threadId, artifactId, version } })),
    staleTime: content === "kept" ? Number.POSITIVE_INFINITY : 0,
    retry: (failures: number, error: unknown) => contentRefusal(error) === null && failures < 2,
  });

const isRefusal = Schema.is(ArtifactContentRefusal);

/** Why the hub does not serve a version's contents, or null when the read failed another way. */
export const contentRefusal = (error: unknown): ArtifactContentRefusal | "not-found" | null => {
  if (!(error instanceof ApiError)) return null;
  if (error.tag === "ArtifactNotFound") return "not-found";
  if (error.tag !== "ArtifactContentUnavailable") return null;
  const { reason } = error.fields;
  return isRefusal(reason) ? reason : "no-contents";
};

/** Where the hub serves a version's contents, for an image to load them itself. */
export const artifactContentUrl = (threadId: ThreadId, artifactId: RegisteredArtifactId, version: number): string =>
  `${API_URL}/api/threads/${encodeURIComponent(threadId)}/artifacts/${encodeURIComponent(artifactId)}/versions/${version}`;

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
    case "ArtifactRegistered": {
      const { threadId, id } = event.artifact;
      // A new version: the artifact's versions, and the latest read from the file now, are read again.
      void queryClient.invalidateQueries({ queryKey: recordKeys.artifact(threadId, id) });
      return readListAgain(queryClient, recordKeys.artifacts(threadId));
    }
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
