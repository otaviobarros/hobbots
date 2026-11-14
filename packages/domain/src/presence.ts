import { Schema } from "effect";
import type { AgentStatus } from "./agent.ts";
import type { ApprovalRequest } from "./approval.ts";
import type { BackpackItem } from "./backpack.ts";
import { AgentId, MessageId, ThreadId } from "./ids.ts";
import { isInProgress, type Message, waitedSteps } from "./message.ts";
import type { Question } from "./quest.ts";
import type { FailedTask } from "./task.ts";

/**
 * What the hub publishes about a thread's run and a hob's presence (ADR 037, the hub decides
 * status), so every device shows the same state and none works it out from messages.
 */

/** Where a thread's run stands: the states of the `ThreadRun` machine. */
export const ThreadRunState = Schema.Literals(["idle", "dispatching", "running", "carrying", "draining"]);
export type ThreadRunState = typeof ThreadRunState.Type;

/**
 * What a running reply is doing: `thinking` before its first words, `working` once it writes, and
 * `waiting` once it has answered and waits only on commands it started (#1056).
 */
export const ReplyActivity = Schema.Literals(["thinking", "working", "waiting"]);
export type ReplyActivity = typeof ReplyActivity.Type;

/** What a reply is doing, or null once it no longer runs. */
export const replyActivity = (reply: Pick<Message, "status" | "steps" | "content">): ReplyActivity | null => {
  if (!isInProgress(reply.status)) return null;
  if (waitedSteps(reply.steps).length > 0) return "waiting";
  return reply.content.length > 0 ? "working" : "thinking";
};

/**
 * A line's run as the hub publishes it: a thread's main line (`rootMessageId` null) or one of its
 * reply threads (ADR 039). `reply` says what the running reply is doing, null while no reply runs;
 * `speaking` is the hob holding the floor and `next` the hobs waiting for it, in order. `revision`
 * orders the changes of every run since the hub started: a client keeps, per line, the one with the
 * highest revision.
 */
export const ThreadRunStatus = Schema.Struct({
  threadId: ThreadId,
  rootMessageId: Schema.NullOr(MessageId),
  run: ThreadRunState,
  reply: Schema.NullOr(ReplyActivity),
  speaking: Schema.NullOr(AgentId),
  next: Schema.Array(AgentId),
  revision: Schema.Int,
});
export type ThreadRunStatus = typeof ThreadRunStatus.Type;

/**
 * A hob's presence: its lifecycle first (paused), then whether something waits on you, then what
 * its threads' replies are doing, the busiest first. `on-command` has answered and waits only on a
 * command it started.
 */
export const HobPresenceState = Schema.Literals(["paused", "needs-you", "working", "thinking", "on-command", "idle"]);
export type HobPresenceState = typeof HobPresenceState.Type;

/** A hob's presence as the hub publishes it. `revision` orders the changes of every hob's presence since the hub started. */
export const HobPresence = Schema.Struct({ agentId: AgentId, state: HobPresenceState, revision: Schema.Int });
export type HobPresence = typeof HobPresence.Type;

/** A hob's presence from its lifecycle, whether something waits on you, and what its running replies are doing. */
export const hobPresenceState = ({
  status,
  needsYou,
  replies,
}: {
  readonly status: AgentStatus;
  readonly needsYou: boolean;
  readonly replies: ReadonlyArray<ReplyActivity>;
}): HobPresenceState => {
  if (status === "paused") return "paused";
  if (needsYou) return "needs-you";
  if (replies.includes("working")) return "working";
  if (replies.includes("thinking")) return "thinking";
  return replies.length > 0 ? "on-command" : "idle";
};

/**
 * The hobs something waits on you for (ADR 027). You talk only to the lead, so what waits marks the
 * hob whose chat it waits in: a pending request, stuck work or a member's failed Task by the chat
 * its work was asked in, and a question by the last lead it climbed. The hob that asks keeps its own
 * state. `leadOf` names the hob a chat belongs to, when it is known.
 */
export const leadsNeedingYou = ({
  approvals,
  blockers,
  questions,
  failed,
  leadOf,
}: {
  readonly approvals: ReadonlyArray<Pick<ApprovalRequest, "agentId" | "threadId" | "state">>;
  readonly blockers: ReadonlyArray<Pick<BackpackItem, "recipientId" | "threadId">>;
  readonly questions: ReadonlyArray<{ readonly question: Pick<Question, "askerId" | "chain"> }>;
  readonly failed: ReadonlyArray<FailedTask>;
  readonly leadOf: (threadId: ThreadId) => AgentId | undefined;
}): ReadonlySet<AgentId> => {
  const lead = (threadId: ThreadId | null, otherwise: AgentId) =>
    (threadId === null ? undefined : leadOf(threadId)) ?? otherwise;
  return new Set([
    ...approvals.flatMap((request) => (request.state === "pending" ? [lead(request.threadId, request.agentId)] : [])),
    ...blockers.map((item) => lead(item.threadId, item.recipientId)),
    ...questions.map(({ question }) => question.chain.at(-1) ?? question.askerId),
    ...failed.map(({ task, leadId }) => leadId ?? lead(task.threadId, task.ownerId)),
  ]);
};

/**
 * The status a client holds, as the hub published it: each busy thread's run and each live hob's
 * presence, and the revision of the snapshot of each kind. A thread or hob it leaves out has none.
 */
export interface StatusView {
  readonly runsRevision: number;
  readonly runs: Readonly<Record<ThreadId, ThreadRunStatus>>;
  readonly presenceRevision: number;
  readonly hobs: Readonly<Record<AgentId, HobPresence>>;
  /** The revision each hob's presence was removed at, so an older change of it is not taken back. */
  readonly removed: Readonly<Record<AgentId, number>>;
}

/** What a client holds on each `Ready`, before its snapshot arrives: nothing, since revisions start again with each hub. */
export const noStatus: StatusView = { runsRevision: -1, runs: {}, presenceRevision: -1, hobs: {}, removed: {} };

/** The snapshot `GET /api/status` serves. */
export interface StatusSnapshot {
  readonly runsRevision: number;
  readonly runs: ReadonlyArray<ThreadRunStatus>;
  readonly presenceRevision: number;
  readonly hobs: ReadonlyArray<HobPresence>;
}

const newerThan = <T>(
  held: Readonly<Record<string, T>>,
  revision: number,
  of: (each: T) => number,
): Record<string, T> => Object.fromEntries(Object.entries(held).filter(([, each]) => of(each) > revision));
const revisionOf = (each: { readonly revision: number }) => each.revision;

/**
 * The status once the snapshot read after `Ready` arrives: what the snapshot holds, except where an
 * event that came while it was read is newer.
 */
export const withSnapshot = (view: StatusView, snapshot: StatusSnapshot): StatusView => {
  // What the client holds of a hob is its presence or its removal, never both. Either one newer
  // than the snapshot wins over what the snapshot had for that hob.
  const removed = newerThan(view.removed, snapshot.presenceRevision, (revision) => revision);
  const hobs = {
    ...Object.fromEntries(snapshot.hobs.map((presence) => [presence.agentId, presence])),
    ...newerThan(view.hobs, snapshot.presenceRevision, revisionOf),
  };
  for (const agentId of Object.keys(removed)) delete hobs[agentId];
  return {
    runsRevision: snapshot.runsRevision,
    runs: {
      ...Object.fromEntries(snapshot.runs.map((run) => [run.threadId, run])),
      ...newerThan(view.runs, snapshot.runsRevision, revisionOf),
    },
    presenceRevision: snapshot.presenceRevision,
    hobs,
    removed,
  };
};

/** A status event the hub publishes on `status` frames. */
export type StatusEvent =
  | { readonly _tag: "ThreadRunChanged"; readonly run: ThreadRunStatus }
  | { readonly _tag: "HobPresenceChanged"; readonly presence: HobPresence }
  | { readonly _tag: "HobPresenceRemoved"; readonly agentId: AgentId; readonly revision: number };

const isNewer = (revision: number, floor: number, held: number | undefined) =>
  revision > floor && revision > (held ?? -1);

/** The revision of what the client holds of a hob: its presence, or its removal, never both. */
const heldPresence = (view: StatusView, agentId: AgentId) => view.hobs[agentId]?.revision ?? view.removed[agentId];

/**
 * The status after an event, when the event is newer than what the client holds. An idle run is
 * kept as a mark of its revision, and `shownStatus` leaves it out.
 */
export const withStatusEvent = (view: StatusView, event: StatusEvent): StatusView => {
  switch (event._tag) {
    case "ThreadRunChanged":
      return isNewer(event.run.revision, view.runsRevision, view.runs[event.run.threadId]?.revision)
        ? { ...view, runs: { ...view.runs, [event.run.threadId]: event.run } }
        : view;
    case "HobPresenceChanged": {
      const { agentId } = event.presence;
      if (!isNewer(event.presence.revision, view.presenceRevision, heldPresence(view, agentId))) return view;
      // A newer presence supersedes the hob's removal, as when it comes back.
      const { [agentId]: _, ...removed } = view.removed;
      return { ...view, hobs: { ...view.hobs, [agentId]: event.presence }, removed };
    }
    case "HobPresenceRemoved": {
      if (!isNewer(event.revision, view.presenceRevision, heldPresence(view, event.agentId))) return view;
      const { [event.agentId]: _, ...hobs } = view.hobs;
      return { ...view, hobs, removed: { ...view.removed, [event.agentId]: event.revision } };
    }
  }
};

/** What the status shows: each busy thread's run and each live hob's presence. */
export const shownStatus = (
  view: StatusView,
): { readonly runs: ReadonlyArray<ThreadRunStatus>; readonly hobs: ReadonlyArray<HobPresence> } => ({
  runs: Object.values(view.runs).filter((run) => run.run !== "idle"),
  hobs: Object.values(view.hobs),
});
