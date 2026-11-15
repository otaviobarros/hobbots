import { Schema } from "effect";
import type { AgentStatus } from "./agent.ts";
import type { ApprovalRequest } from "./approval.ts";
import type { BackpackItem } from "./backpack.ts";
import { AgentId, MessageId, ChannelId } from "./ids.ts";
import { isInProgress, type Message, waitedSteps } from "./message.ts";
import type { Question } from "./quest.ts";
import type { FailedTask, Task } from "./task.ts";

/**
 * What the hub publishes about a channel's run and a hob's presence (ADR 037, the hub decides
 * status), so every device shows the same state and none works it out from messages.
 */

/** Where a channel's run stands: the states of the `ChannelRun` machine. */
export const ChannelRunState = Schema.Literals(["idle", "dispatching", "running", "carrying", "draining"]);
export type ChannelRunState = typeof ChannelRunState.Type;

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
 * A line's run as the hub publishes it: a channel's main line (`rootMessageId` null) or one of its
 * threads (ADR 039). `reply` says what the running reply is doing, null while no reply runs;
 * `speaking` is the hob holding the floor and `next` the hobs waiting for it, in order; `paused` the
 * hobs whose relay went past the budget and waits for a person, empty while none did. `revision`
 * orders the changes of every run since the hub started: a client keeps, per line, the one with the
 * highest revision.
 */
export const ChannelRunStatus = Schema.Struct({
  channelId: ChannelId,
  rootMessageId: Schema.NullOr(MessageId),
  run: ChannelRunState,
  reply: Schema.NullOr(ReplyActivity),
  speaking: Schema.NullOr(AgentId),
  next: Schema.Array(AgentId),
  paused: Schema.Array(AgentId),
  revision: Schema.Int,
});
export type ChannelRunStatus = typeof ChannelRunStatus.Type;

/**
 * A hob's presence: its lifecycle first (paused), then whether something waits on you, then what
 * its channels' replies are doing, the busiest first. `on-command` has answered and waits only on a
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
  readonly approvals: ReadonlyArray<Pick<ApprovalRequest, "agentId" | "channelId" | "state">>;
  readonly blockers: ReadonlyArray<Pick<BackpackItem, "recipientId" | "channelId">>;
  readonly questions: ReadonlyArray<{ readonly question: Pick<Question, "askerId" | "chain"> }>;
  readonly failed: ReadonlyArray<FailedTask>;
  readonly leadOf: (channelId: ChannelId) => AgentId | undefined;
}): ReadonlySet<AgentId> => {
  const lead = (channelId: ChannelId | null, otherwise: AgentId) =>
    (channelId === null ? undefined : leadOf(channelId)) ?? otherwise;
  return new Set([
    ...approvals.flatMap((request) => (request.state === "pending" ? [lead(request.channelId, request.agentId)] : [])),
    ...blockers.map((item) => lead(item.channelId, item.recipientId)),
    ...questions.map(({ question }) => question.chain.at(-1) ?? question.askerId),
    ...failed.map(({ task, leadId }) => leadId ?? lead(task.channelId, task.ownerId)),
  ]);
};

/**
 * The channels where something waits on you: a pending approval asked there, a blocker sent there, a
 * question for a person from a Task started there, or a member's failed Task under one (ADR 039, The
 * sidebar). Only the channels where you are the decider count (`decides`, from `deciderOf`): the
 * other members of a shared camp wait on that person, and are not asked themselves. The sidebar
 * marks each of them Needs you.
 */
export const channelsNeedingYou = ({
  approvals,
  blockers,
  questions,
  failed,
  decides,
}: {
  readonly approvals: ReadonlyArray<Pick<ApprovalRequest, "channelId" | "state">>;
  readonly blockers: ReadonlyArray<Pick<BackpackItem, "channelId">>;
  readonly questions: ReadonlyArray<{
    readonly question: Pick<Question, "recipientId">;
    readonly task: Pick<Task, "channelId">;
  }>;
  readonly failed: ReadonlyArray<{ readonly task: Pick<Task, "channelId"> }>;
  readonly decides: (channelId: ChannelId) => boolean;
}): ReadonlySet<ChannelId> =>
  new Set(
    [
      ...approvals.flatMap((request) => (request.state === "pending" ? [request.channelId] : [])),
      ...blockers.map((item) => item.channelId),
      ...questions.flatMap(({ question, task }) => (question.recipientId === null ? [task.channelId] : [])),
      ...failed.map(({ task }) => task.channelId),
    ].flatMap((channelId) => (channelId === null || !decides(channelId) ? [] : [channelId])),
  );

/**
 * The status a client holds, as the hub published it: each busy channel's run and each live hob's
 * presence, and the revision of the snapshot of each kind. A channel or hob it leaves out has none.
 */
export interface StatusView {
  readonly runsRevision: number;
  readonly runs: Readonly<Record<ChannelId, ChannelRunStatus>>;
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
  readonly runs: ReadonlyArray<ChannelRunStatus>;
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
      ...Object.fromEntries(snapshot.runs.map((run) => [run.channelId, run])),
      ...newerThan(view.runs, snapshot.runsRevision, revisionOf),
    },
    presenceRevision: snapshot.presenceRevision,
    hobs,
    removed,
  };
};

/** A status event the hub publishes on `status` frames. */
export type StatusEvent =
  | { readonly _tag: "ChannelRunChanged"; readonly run: ChannelRunStatus }
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
    case "ChannelRunChanged":
      return isNewer(event.run.revision, view.runsRevision, view.runs[event.run.channelId]?.revision)
        ? { ...view, runs: { ...view.runs, [event.run.channelId]: event.run } }
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

/**
 * What the status shows: each busy channel's run, or idle one whose hobs wait for a person after the
 * relay budget (ADR 039), and each live hob's presence.
 */
export const shownStatus = (
  view: StatusView,
): { readonly runs: ReadonlyArray<ChannelRunStatus>; readonly hobs: ReadonlyArray<HobPresence> } => ({
  runs: Object.values(view.runs).filter((run) => run.run !== "idle" || run.paused.length > 0),
  hobs: Object.values(view.hobs),
});
