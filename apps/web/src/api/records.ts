import type { RecordDecisionPayload } from "@hobbots/api";
import {
  type Artifact,
  ArtifactContentRefusal,
  type ArtifactReviewOutcome,
  type ArtifactVersionContent,
  type ChannelId,
  type Decision,
  type DecisionId,
  type HobbotsEvent,
  type RegisteredArtifactId,
} from "@hobbots/domain";
import { type QueryClient, queryOptions, useMutation, useQueryClient } from "@tanstack/react-query";
import { Schema } from "effect";
import { API_URL, ApiError, call } from "./client.ts";
import { followsEvents } from "./queries.ts";

// A chat's or camp's records (ADR 037), as the camp sheet shows them: its decisions, its artifacts at
// their latest version and its brief, each as the hub keeps it. Their events read the list again.

export const recordKeys = {
  decisions: (channelId: ChannelId) => ["channels", channelId, "decisions"] as const,
  artifacts: (channelId: ChannelId) => ["channels", channelId, "artifacts"] as const,
  brief: (channelId: ChannelId) => ["channels", channelId, "brief"] as const,
  /** Every artifact's versions and contents read in the channel, so a moved chapter drops them all. */
  artifactReads: (channelId: ChannelId) => ["channels", channelId, "artifact"] as const,
  /** One artifact's versions and their contents, under one key so a new version reads them again. */
  artifact: (channelId: ChannelId, artifactId: RegisteredArtifactId) =>
    [...recordKeys.artifactReads(channelId), artifactId] as const,
  versions: (channelId: ChannelId, artifactId: RegisteredArtifactId) =>
    [...recordKeys.artifact(channelId, artifactId), "versions"] as const,
  content: (channelId: ChannelId, artifactId: RegisteredArtifactId, version: number) =>
    [...recordKeys.artifact(channelId, artifactId), "content", version] as const,
};

/** The channel's decisions, newest first, crossed-out ones kept. */
export const decisionsQuery = (channelId: ChannelId) =>
  queryOptions({
    queryKey: recordKeys.decisions(channelId),
    queryFn: () => call((c) => c.records.decisions({ params: { channelId } })),
    ...followsEvents,
  });

/** One row per artifact at its latest version, the most recently changed first. */
export const artifactsQuery = (channelId: ChannelId) =>
  queryOptions({
    queryKey: recordKeys.artifacts(channelId),
    queryFn: () => call((c) => c.records.artifacts({ params: { channelId } })),
    ...followsEvents,
  });

/** An artifact's versions, newest first, and how it is shown (#1434). */
export const artifactVersionsQuery = (channelId: ChannelId, artifactId: RegisteredArtifactId) =>
  queryOptions({
    queryKey: recordKeys.versions(channelId, artifactId),
    queryFn: () => call((c) => c.records.artifactVersions({ params: { channelId, artifactId } })),
    ...followsEvents,
  });

/**
 * One version's contents as the hub serves them: text redacted and cut, an image as it is. What the
 * hub kept for a version does not change while the number names it, so it is not read again until a
 * moved chapter numbers the versions again (`forgetArtifactReads`); the latest version read from the
 * file now is read again with the artifact. A refusal is an answer, not a failure to retry.
 */
export const artifactContentQuery = (
  channelId: ChannelId,
  artifactId: RegisteredArtifactId,
  version: number,
  content: ArtifactVersionContent | "unknown",
) =>
  queryOptions({
    queryKey: recordKeys.content(channelId, artifactId, version),
    queryFn: () => call((c) => c.records.artifactContent({ params: { channelId, artifactId, version } })),
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
export const artifactContentUrl = (channelId: ChannelId, artifactId: RegisteredArtifactId, version: number): string =>
  `${API_URL}/api/channels/${encodeURIComponent(channelId)}/artifacts/${encodeURIComponent(artifactId)}/versions/${version}`;

/** The "Where we are" the hub writes, or null before it first writes one. */
export const briefQuery = (channelId: ChannelId) =>
  queryOptions({
    queryKey: recordKeys.brief(channelId),
    queryFn: () => call((c) => c.records.brief({ params: { channelId } })),
    ...followsEvents,
  });

/**
 * Reads a channel's list again after its event. A read already on its way may predate the change, so
 * it is cancelled first (STD-REACT-012).
 */
export const readListAgain = async (queryClient: QueryClient, queryKey: ReadonlyArray<unknown>): Promise<void> => {
  await queryClient.cancelQueries({ queryKey, exact: true });
  await queryClient.invalidateQueries({ queryKey, exact: true });
};

/**
 * A new version of an artifact: its versions, and the latest read from the file now, are read again.
 * Reads already on their way may predate it, so they are cancelled first (STD-REACT-012).
 */
const readArtifactAgain = async (
  queryClient: QueryClient,
  channelId: ChannelId,
  artifactId: RegisteredArtifactId,
): Promise<void> => {
  const queryKey = recordKeys.artifact(channelId, artifactId);
  await queryClient.cancelQueries({ queryKey });
  await queryClient.invalidateQueries({ queryKey });
};

/**
 * A chapter moved into or out of the channel: an artifact that took another's records numbers its
 * versions again, so a version number may now name other contents. Every artifact's versions and
 * contents read in the channel are cancelled and dropped, kept ones too, and what is on screen reads
 * them again.
 */
export const forgetArtifactReads = async (queryClient: QueryClient, channelId: ChannelId): Promise<void> => {
  const queryKey = recordKeys.artifactReads(channelId);
  await queryClient.cancelQueries({ queryKey });
  await queryClient.resetQueries({ queryKey });
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
      return readListAgain(queryClient, recordKeys.decisions(event.decision.channelId));
    case "ArtifactRegistered": {
      const { channelId, id } = event.artifact;
      return Promise.all([
        readArtifactAgain(queryClient, channelId, id),
        readListAgain(queryClient, recordKeys.artifacts(channelId)),
      ]).then(() => undefined);
    }
    case "ArtifactReviewSettled":
      return readListAgain(queryClient, recordKeys.artifacts(event.artifact.channelId));
    case "BriefWritten":
      return readListAgain(queryClient, recordKeys.brief(event.brief.channelId));
  }
};

/** Puts the decisions the hub answered in the list, each in place of the copy it held. */
const takeDecisions = (queryClient: QueryClient, channelId: ChannelId, changed: ReadonlyArray<Decision>) =>
  queryClient.setQueryData<ReadonlyArray<Decision>>(recordKeys.decisions(channelId), (old) => {
    if (old === undefined) return old;
    const fresh = changed.filter((decision) => !old.some((each) => each.id === decision.id));
    const replaced = old.map((each) => changed.find((decision) => decision.id === each.id) ?? each);
    return [...fresh, ...replaced];
  });

/** Records a decision of yours, replacing `replaces` when it changes one; `key` records it once. */
export const useRecordDecision = (channelId: ChannelId) => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: RecordDecisionPayload) =>
      call((c) => c.records.recordDecision({ params: { channelId }, payload })),
    onSuccess: ({ recorded, superseded }) =>
      takeDecisions(queryClient, channelId, superseded === null ? [recorded] : [recorded, superseded]),
  });
};

/** Crosses a decision out: it stays, no longer holding. */
export const useCrossOutDecision = (channelId: ChannelId) => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (decisionId: DecisionId) =>
      call((c) => c.records.crossOutDecision({ params: { channelId, decisionId } })),
    onSuccess: (decision) => takeDecisions(queryClient, channelId, [decision]),
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
export const useReviewArtifact = (channelId: ChannelId) => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      artifactId,
      outcome,
    }: {
      readonly artifactId: RegisteredArtifactId;
      readonly outcome: ArtifactReviewOutcome;
    }) => call((c) => c.records.reviewArtifact({ params: { channelId, artifactId }, payload: { outcome } })),
    onSuccess: (artifact) =>
      queryClient.setQueryData<ReadonlyArray<Artifact>>(recordKeys.artifacts(channelId), (old) =>
        old?.map((each) => (each.id === artifact.id ? artifact : each)),
      ),
  });
};
