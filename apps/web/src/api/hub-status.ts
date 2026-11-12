import {
  type AgentId,
  HobPresenceChanged,
  HobPresenceRemoved,
  type HobPresenceState,
  noStatus,
  type ReplyActivity,
  type StatusView,
  shownStatus,
  type ThreadId,
  ThreadRunChanged,
  type ThreadRunStatus,
  withSnapshot,
  withStatusEvent,
} from "@hobbots/domain";
import { type QueryClient, queryOptions, useQuery } from "@tanstack/react-query";
import { Schema } from "effect";
import { call } from "./client.ts";

/**
 * The status the hub decides (ADR 037): each busy thread's run and each live hob's presence. The
 * window renders it as published and never works it out from messages (STD-REACT-028). It reads the
 * snapshot `GET /api/status` serves, then follows `status` frames, keeping per thread and per hob
 * whichever has the higher revision.
 */

const statusKey = ["hub-status"] as const;

/** How many `Ready` frames this client has seen: a snapshot read before the latest one is read again. */
const readies = new WeakMap<QueryClient, number>();
const readyCount = (client: QueryClient) => readies.get(client) ?? 0;

export const hubStatusQuery = queryOptions({
  queryKey: statusKey,
  queryFn: async ({ client }): Promise<StatusView> => {
    for (;;) {
      const ready = readyCount(client);
      const snapshot = await call((c) => c.system.status());
      // Taken against what the client holds now, so a status event that came while it was read wins.
      if (readyCount(client) === ready) return withSnapshot(client.getQueryData(statusKey) ?? noStatus, snapshot);
    }
  },
  staleTime: Number.POSITIVE_INFINITY,
});

/**
 * A `Ready` frame: status events are not replayed and revisions start again with each hub, so the
 * client drops what it held and reads the snapshot again.
 */
export const statusReady = (queryClient: QueryClient) => {
  readies.set(queryClient, readyCount(queryClient) + 1);
  queryClient.setQueryData<StatusView>(statusKey, noStatus);
  void queryClient.invalidateQueries({ queryKey: statusKey, exact: true });
};

const decodeStatusEvent = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Union([ThreadRunChanged, HobPresenceChanged, HobPresenceRemoved])),
);

/** A `status` frame: a thread's run or a hob's presence changed, or a hob's presence was removed. */
export const applyStatusFrame = (queryClient: QueryClient, data: string) => {
  const event = decodeStatusEvent(data);
  queryClient.setQueryData<StatusView>(statusKey, (old) => withStatusEvent(old ?? noStatus, event));
};

/** What a thread's reply is doing, by thread; a thread left out runs no reply. */
export type ActivityMap = Readonly<Record<ThreadId, ReplyActivity>>;
/** Each busy thread's run; a thread left out is idle. */
export type RunMap = Readonly<Record<ThreadId, ThreadRunStatus>>;
/** Each live hob's presence; a hob left out has none yet. */
export type PresenceMap = Readonly<Record<AgentId, HobPresenceState>>;

const runsOf = (view: StatusView): RunMap =>
  Object.fromEntries(shownStatus(view).runs.map((run) => [run.threadId, run]));
const repliesOf = (view: StatusView): ActivityMap =>
  Object.fromEntries(
    shownStatus(view).runs.flatMap((run) => (run.reply === null ? [] : [[run.threadId, run.reply] as const])),
  );
const presenceOf = (view: StatusView): PresenceMap =>
  Object.fromEntries(shownStatus(view).hobs.map((presence) => [presence.agentId, presence.state]));

const NO_RUNS: RunMap = {};
const NO_REPLIES: ActivityMap = {};
const NO_PRESENCE: PresenceMap = {};

/** Each busy thread's run, as the hub published it. */
export const useThreadRuns = (): RunMap => useQuery({ ...hubStatusQuery, select: runsOf }).data ?? NO_RUNS;

/** What each thread's running reply is doing, as the hub published it. */
export const useThreadReplies = (): ActivityMap =>
  useQuery({ ...hubStatusQuery, select: repliesOf }).data ?? NO_REPLIES;

/** Each live hob's presence, as the hub published it. */
export const useHobPresence = (): PresenceMap =>
  useQuery({ ...hubStatusQuery, select: presenceOf }).data ?? NO_PRESENCE;
