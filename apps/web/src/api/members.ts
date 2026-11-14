import type { MembersReport } from "@hobbots/api";
import type { Actor, HobbotsEvent, ThreadId } from "@hobbots/domain";
import { type QueryClient, queryOptions, useMutation, useQueryClient } from "@tanstack/react-query";
import { localDay, periodStart } from "../lib/usage.ts";
import { call } from "./client.ts";
import { sidebarChanged } from "./sidebar.ts";

// A camp's members sheet (ADR 039, Members; Status and cost): who is in it and what its hobs spent
// there today, as the hub reads them, and adding a hob or taking one out.

const membersKey = (threadId: ThreadId) => ["threads", threadId, "members"] as const;

/**
 * The thread's members and each hob's turns and tokens there today, from the start of the reader's
 * own day. `today` keys the read to that day, so the numbers start again at midnight. Kept current
 * by the member events and by each reply that settles there.
 */
const membersQuery = (threadId: ThreadId, today: string) =>
  queryOptions({
    queryKey: [...membersKey(threadId), today] as const,
    queryFn: (): Promise<MembersReport> =>
      call((c) => c.members.list({ params: { threadId }, query: { since: periodStart(new Date(), 1).toISOString() } })),
    staleTime: 30_000,
  });

/** The members read for the reader's day now. */
export const membersToday = (threadId: ThreadId) => membersQuery(threadId, localDay(new Date()));

/** Someone joined or left the thread, or a reply there settled: its members are read again. */
const membersChanged = async (queryClient: QueryClient, threadId: ThreadId) => {
  // A read already in flight may predate the change, so it is cancelled first (STD-REACT-012).
  await queryClient.cancelQueries({ queryKey: membersKey(threadId) });
  await queryClient.invalidateQueries({ queryKey: membersKey(threadId) });
};

/**
 * The threads whose members sheets an event changes: a member's, that of a hob's reply that settled
 * or turn it passed, or both threads of a chapter that moved, whose replies count where they now are.
 */
const changedThreads = (event: HobbotsEvent): ReadonlyArray<ThreadId> => {
  if (event._tag === "ChapterMoved") return [event.thread.id, event.camp.id];
  const one = changedThread(event);
  return one === null ? [] : [one];
};

const changedThread = (event: HobbotsEvent): ThreadId | null => {
  if (event._tag === "ThreadMemberAdded" || event._tag === "ThreadMemberChanged") return event.member.threadId;
  // A passed turn leaves no reply, but what it used still counts here.
  if (event._tag === "TurnPassed") return event.threadId;
  // A reply counts once it settles: streaming updates change no total.
  if (event._tag === "MessageUpserted" && event.message.role === "assistant") {
    const status = event.message.status;
    return status === "streaming" || status === "stopping" || status === "queued" ? null : event.message.threadId;
  }
  return null;
};

/** Reads a members sheet again after an event that changes it; the event's own handling goes on. */
export const applyMembersEvent = (queryClient: QueryClient, event: HobbotsEvent) => {
  for (const threadId of changedThreads(event)) void membersChanged(queryClient, threadId);
};

/** Adds a hob to the camp, or brings back one taken out. */
export const useAddMember = (threadId: ThreadId) => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (actor: Actor) => call((c) => c.members.add({ params: { threadId }, payload: { actor } })),
    onSuccess: () => Promise.all([membersChanged(queryClient, threadId), sidebarChanged(queryClient)]),
  });
};

/** Takes a member out of the camp: a hob's answers still owed there are dropped with it. */
export const useRemoveMember = (threadId: ThreadId) => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (actor: Actor) =>
      call((c) => c.members.remove({ params: { threadId, kind: actor.kind, id: actor.id } })),
    onSuccess: () => Promise.all([membersChanged(queryClient, threadId), sidebarChanged(queryClient)]),
  });
};
