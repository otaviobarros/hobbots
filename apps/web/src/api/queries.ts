import type {
  CreateAgentPayload,
  HobPermissions,
  SetBrainPayload,
  UpdateAgentPayload,
  UpdateHobPermissionsPayload,
} from "@hobbots/api";
import type {
  Agent,
  AgentId,
  Brain,
  Message,
  MessageId,
  RetireWork,
  RuntimeKind,
  ThreadId,
  UsagePeriod,
} from "@hobbots/domain";
import { messagePreview, Thread } from "@hobbots/domain";
import { keepPreviousData, type QueryClient, queryOptions, useMutation, useQueryClient } from "@tanstack/react-query";
import { periodStart } from "../lib/usage.ts";
import { ApiError, call } from "./client.ts";
import { runtimeRefetchOnFocus } from "./runtime-health.ts";
import { newer, syncedAgents, syncedMessages, syncedThreads } from "./sync.ts";

export const queryKeys = {
  agents: ["agents"] as const,
  archivedAgents: ["archivedAgents"] as const,
  threads: (agentId: AgentId) => ["agents", agentId, "threads"] as const,
  archivedThreads: (agentId: AgentId) => ["agents", agentId, "archivedThreads"] as const,
  messages: (threadId: ThreadId) => ["threads", threadId, "messages"] as const,
  runtimes: ["runtimes"] as const,
  models: (runtime: RuntimeKind) => ["runtimes", runtime, "models"] as const,
  permissions: (agentId: AgentId) => ["agents", agentId, "permissions"] as const,
  usage: (days: UsagePeriod, today: string) => ["usage", days, today] as const,
  plans: ["plans"] as const,
};

/**
 * For a query the event stream keeps current: it never goes stale on its own, so opening a page
 * that shows it reads nothing. A fresh `Ready` still refetches it (ADR 013).
 */
export const followsEvents = { staleTime: Number.POSITIVE_INFINITY } as const;

/** The hobs that are not retired. */
export const agentsQuery = queryOptions({
  queryKey: queryKeys.agents,
  ...followsEvents,
  queryFn: syncedAgents(() => call((c) => c.agents.list({ query: {} })), false),
});

/** Archived hobs: the retired ones, most recently retired first. */
export const archivedAgentsQuery = queryOptions({
  queryKey: queryKeys.archivedAgents,
  ...followsEvents,
  queryFn: syncedAgents(
    () => call((c) => c.agents.list({ query: { status: "retired" } })),
    true,
    (hobs) => sortArchived(hobs),
  ),
});

/** Most recently retired first; hobs retired before the time was recorded go last. */
export const sortArchived = (hobs: ReadonlyArray<Agent>): Array<Agent> =>
  [...hobs].sort((a, b) => (b.retiredAt ?? "").localeCompare(a.retiredAt ?? ""));

export const threadsQuery = (agentId: AgentId) =>
  queryOptions({
    queryKey: queryKeys.threads(agentId),
    ...followsEvents,
    queryFn: syncedThreads(
      agentId,
      () => call((c) => c.agents.threads({ params: { agentId }, query: {} })),
      sortThreads,
      false,
    ),
  });

/** A hob's archived threads, most recently archived first. */
export const archivedThreadsQuery = (agentId: AgentId) =>
  queryOptions({
    queryKey: queryKeys.archivedThreads(agentId),
    ...followsEvents,
    queryFn: syncedThreads(
      agentId,
      () => call((c) => c.agents.threads({ params: { agentId }, query: { archived: "true" } })),
      sortArchivedThreads,
      true,
    ),
  });

export const messagesQuery = (threadId: ThreadId) =>
  queryOptions({
    queryKey: queryKeys.messages(threadId),
    ...followsEvents,
    queryFn: syncedMessages(threadId, () => call((c) => c.threads.messages({ params: { threadId } })), upsertMessage),
  });

export const runtimesQuery = queryOptions({
  queryKey: queryKeys.runtimes,
  queryFn: () => call((c) => c.system.runtimes()),
  // Each check runs the providers' CLIs, so opening a page or a thread doesn't check again.
  staleTime: 60_000,
  refetchOnWindowFocus: (query) => runtimeRefetchOnFocus(query.state.data),
});

/**
 * What each hob's replies used over the reader's last 7 or 30 days, from the start of their own first
 * day (OP-002). `today` keys the report to the reader's day. Switching the period keeps the last
 * numbers on screen until the new ones arrive, so each report carries the period it counts.
 */
export const usageQuery = (days: UsagePeriod, today: string) =>
  queryOptions({
    queryKey: queryKeys.usage(days, today),
    queryFn: () =>
      call((c) => c.usage.usage({ query: { days, since: periodStart(new Date(), Number(days)).toISOString() } })).then(
        (report) => ({ ...report, days }),
      ),
    staleTime: 30_000,
    placeholderData: keepPreviousData,
  });

/**
 * Each runtime's plan, as it reports it (OP-002). Asking a runtime for its plan starts it and can
 * take seconds, so it is its own request, read again at most every half minute.
 */
export const plansQuery = queryOptions({
  queryKey: queryKeys.plans,
  queryFn: () => call((c) => c.usage.plans()),
  staleTime: 30_000,
});

/** The models a runtime offers a hob's brain. */
export const modelsQuery = (runtime: RuntimeKind) =>
  queryOptions({
    queryKey: queryKeys.models(runtime),
    queryFn: () => call((c) => c.runtimes.models({ params: { runtime } })),
    staleTime: 60_000,
  });

/** Creates a hob; the hob list gains it now rather than waiting for the live event. */
export const useCreateHob = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: CreateAgentPayload) => call((c) => c.agents.create({ payload })),
    onSuccess: (hob) => queryClient.setQueryData<ReadonlyArray<Agent>>(queryKeys.agents, (old) => upsertById(old, hob)),
  });
};

/**
 * Writes a hob the hub returned into the hob lists now rather than waiting for the live event. A
 * retired hob leaves the hob list for the retired ones, and one brought back goes the other way.
 */
const useHobChange = <V>(change: (variables: V) => Promise<Agent>) => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: change,
    onSuccess: (hob) => {
      const retired = hob.status === "retired";
      queryClient.setQueryData<ReadonlyArray<Agent>>(queryKeys.agents, (old) =>
        retired ? old?.filter((h) => h.id !== hob.id) : upsertById(old, hob),
      );
      queryClient.setQueryData<ReadonlyArray<Agent>>(queryKeys.archivedAgents, (old) =>
        retired ? old && sortArchived(upsertById(old, hob)) : old?.filter((h) => h.id !== hob.id),
      );
    },
  });
};

/** Edits a hob's configuration; each edit that changes something is its next version. */
export const useUpdateHob = (agentId: AgentId) =>
  useHobChange((payload: UpdateAgentPayload) => call((c) => c.agents.update({ params: { agentId }, payload })));

/** Pauses or wakes a hob. */
export const usePauseHob = (agentId: AgentId) =>
  useHobChange((pause: boolean) =>
    call((c) => (pause ? c.agents.pause({ params: { agentId } }) : c.agents.wake({ params: { agentId } }))),
  );

/** Retires a hob; its replies finish or stop, and nothing is deleted. */
export const useRetireHob = (agentId: AgentId) =>
  useHobChange((activeWork: RetireWork) =>
    call((c) => c.agents.retire({ params: { agentId }, payload: { activeWork } })),
  );

/** Brings a retired hob back, active with all its chats. */
export const useBringBackHob = () =>
  useHobChange((agentId: AgentId) => call((c) => c.agents.bringBack({ params: { agentId } })));

/** Retires a hob again after it was brought back by mistake; replies it started finish. */
export const useRetireAgain = () =>
  useHobChange((agentId: AgentId) =>
    call((c) => c.agents.retire({ params: { agentId }, payload: { activeWork: "finish" } })),
  );

/**
 * What a hob may touch. The answer depends on the hob's configuration version and on the setup's
 * preset and shared folders, so `basis` names those and a change to any of them reads it again.
 */
export const permissionsQuery = (agentId: AgentId, basis: ReadonlyArray<unknown>) =>
  queryOptions({
    queryKey: [...queryKeys.permissions(agentId), ...basis],
    queryFn: () => call((c) => c.permissions.get({ params: { agentId } })),
    placeholderData: (previous: HobPermissions | undefined) => previous,
  });

/**
 * Stores a saved answer without going back in time. Another window may have saved a later version
 * whose read finished first, so the answer replaces only older ones; reads still on their way are
 * cancelled and every version is read again, so the hub decides what shows.
 */
export const storeSavedPermissions = async (
  queryClient: QueryClient,
  agentId: AgentId,
  permissions: HobPermissions,
) => {
  const queryKey = queryKeys.permissions(agentId);
  await queryClient.cancelQueries({ queryKey });
  queryClient.setQueriesData<HobPermissions>({ queryKey }, (current) =>
    current !== undefined && current.configVersion > permissions.configVersion ? current : permissions,
  );
  await queryClient.invalidateQueries({ queryKey });
};

/**
 * Changes a hob's folders or overrides; each change is its next configuration version. The answer
 * shows at once unless a later one already does; the hob list hears of the new version from its
 * event, which reads them again.
 */
export const useUpdatePermissions = (agentId: AgentId) => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: UpdateHobPermissionsPayload) =>
      call((c) => c.permissions.update({ params: { agentId }, payload })),
    onSuccess: (permissions) => storeSavedPermissions(queryClient, agentId, permissions),
  });
};

/** Inserts or replaces by id, keeping the list order stable for existing items. */
export const upsertById = <T extends { readonly id: string }>(
  list: ReadonlyArray<T> | undefined,
  item: T,
): Array<T> => {
  const items = list ? [...list] : [];
  const index = items.findIndex((existing) => existing.id === item.id);
  if (index === -1) items.push(item);
  else items[index] = item;
  return items;
};

/** Adds an item unless a live event already delivered it (possibly newer); null adds nothing. */
const insertIfMissing = <T extends { readonly id: string }>(list: ReadonlyArray<T> | undefined, item: T | null) =>
  item === null || list?.some((existing) => existing.id === item.id) ? [...(list ?? [])] : upsertById(list, item);

/**
 * Applies a stored message. A queued message that starts moves to the end, where its turn begins,
 * so the transcript reads in the order turns ran (CH-008).
 */
export const upsertMessage = (list: ReadonlyArray<Message>, message: Message): Array<Message> => {
  const old = list.find((existing) => existing.id === message.id);
  return old?.status === "queued" && message.status !== "queued"
    ? [...list.filter((existing) => existing.id !== message.id), message]
    : upsertById(list, message);
};

const sortThreads = (threads: Array<Thread>) => threads.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

const sortArchivedThreads = (threads: Array<Thread>) =>
  threads.sort((a, b) => (b.archivedAt ?? "").localeCompare(a.archivedAt ?? ""));

/**
 * Puts a thread the hub returned or announced in its hob's list by its `archivedAt`: a live thread in
 * the thread list, an archived one in the archived list, and out of the other. An older version than
 * the one already shown changes nothing. Lists not loaded yet stay unloaded.
 */
export const placeThread = (queryClient: QueryClient, thread: Thread) => {
  const archived = thread.archivedAt !== null;
  const known = [queryKeys.threads(thread.agentId), queryKeys.archivedThreads(thread.agentId)]
    .flatMap((key) => queryClient.getQueryData<ReadonlyArray<Thread>>(key) ?? [])
    .find((existing) => existing.id === thread.id);
  if (newer(known, thread) !== thread) return;
  const into = archived ? queryKeys.archivedThreads(thread.agentId) : queryKeys.threads(thread.agentId);
  const outOf = archived ? queryKeys.threads(thread.agentId) : queryKeys.archivedThreads(thread.agentId);
  const order = archived ? sortArchivedThreads : sortThreads;
  queryClient.setQueryData<ReadonlyArray<Thread>>(into, (old) => (old ? order(upsertById(old, thread)) : old));
  queryClient.setQueryData<ReadonlyArray<Thread>>(outOf, (old) => old?.filter((t) => t.id !== thread.id));
};

const isThreadList = (query: { readonly queryKey: ReadonlyArray<unknown> }) =>
  query.queryKey[0] === "agents" && /^(threads|archivedThreads)$/.test(String(query.queryKey[2]));

/**
 * A message the transcript shows becomes its thread's last line in the hob's thread lists, so a
 * list of chats follows a reply as it lands. The hub works out the same line when it reads them.
 */
export const showLastLine = (queryClient: QueryClient, message: Message) => {
  const lists = queryClient.getQueriesData<ReadonlyArray<Thread>>({ predicate: isThreadList });
  if (message.quiet) {
    // A reply kept quiet as it completes may already be the last line, from a read or a step while it
    // streamed. The hub reads the line from the message before it, so the lists holding the thread
    // are read again (#1006).
    for (const [key, threads] of lists)
      if (threads?.some((thread) => thread.id === message.threadId))
        void queryClient.invalidateQueries({ queryKey: key, exact: true });
    return;
  }
  const lastLine = messagePreview(message);
  if (lastLine === null) return;
  for (const [key, threads] of lists) {
    if (!threads?.some((thread) => thread.id === message.threadId && thread.lastLine !== lastLine)) continue;
    queryClient.setQueryData<ReadonlyArray<Thread>>(key, (old) =>
      old?.map((thread) => (thread.id === message.threadId ? new Thread({ ...thread, lastLine }) : thread)),
    );
  }
};

/**
 * A hob that refused a message was paused or retired where this client has not heard yet, so the
 * hob list is fetched again and the chat shows why.
 */
const refreshIfUnavailable = (queryClient: QueryClient) => (error: Error) => {
  if (error instanceof ApiError && error.tag === "HobUnavailable")
    void queryClient.invalidateQueries({ queryKey: queryKeys.agents, exact: true });
};

/** Sends a prompt and puts it and its reply in the thread, without a component to report to. */
export const sendPrompt = async (queryClient: QueryClient, threadId: ThreadId, content: string) => {
  try {
    const sent = await call((c) => c.threads.sendPrompt({ params: { threadId }, payload: { content } }));
    queryClient.setQueryData<ReadonlyArray<Message>>(queryKeys.messages(threadId), (old) =>
      insertIfMissing(insertIfMissing(old, sent.userMessage), sent.assistantMessage),
    );
    return sent;
  } catch (error) {
    refreshIfUnavailable(queryClient)(error as Error);
    throw error;
  }
};

export const useSendPrompt = (threadId: ThreadId) => {
  const queryClient = useQueryClient();
  return useMutation({ mutationFn: (content: string) => sendPrompt(queryClient, threadId, content) });
};

/** Takes a queued message out of the thread before it starts. */
export const useRemoveQueued = (threadId: ThreadId) => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (messageId: MessageId) => call((c) => c.threads.removeQueued({ params: { threadId, messageId } })),
    onSuccess: (_, messageId) => {
      queryClient.setQueryData<ReadonlyArray<Message>>(queryKeys.messages(threadId), (old) =>
        old?.filter((message) => message.id !== messageId),
      );
    },
  });
};

/** Stops the running reply and starts this queued message next. */
export const useSendNow = (threadId: ThreadId) =>
  useMutation({
    mutationFn: (messageId: MessageId) => call((c) => c.threads.sendNow({ params: { threadId, messageId } })),
  });

export const useInterrupt = (threadId: ThreadId) =>
  useMutation({
    mutationFn: () => call((c) => c.threads.interrupt({ params: { threadId } })),
  });

/** Stop waiting: ends a reply that only waits on commands, keeping its text (#1056). */
export const useStopWaiting = (threadId: ThreadId) =>
  useMutation({
    mutationFn: () => call((c) => c.threads.stopWaiting({ params: { threadId } })),
  });

/** Creates a thread and sends its first prompt, so a new thread only appears once it has a message. */
export const startThread = async (queryClient: QueryClient, agentId: AgentId, content: string) => {
  try {
    const thread = await call((c) => c.agents.createThread({ params: { agentId } }));
    // An empty list lets live events for the first reply land while the prompt is sent.
    queryClient.setQueryData<ReadonlyArray<Message>>(queryKeys.messages(thread.id), []);
    const sent = await call((c) => c.threads.sendPrompt({ params: { threadId: thread.id }, payload: { content } }));
    queryClient.setQueryData<ReadonlyArray<Thread>>(queryKeys.threads(agentId), (old) =>
      sortThreads(insertIfMissing(old, thread)),
    );
    queryClient.setQueryData<ReadonlyArray<Message>>(queryKeys.messages(thread.id), (old) =>
      insertIfMissing(insertIfMissing(old, sent.userMessage), sent.assistantMessage),
    );
    return { thread, ...sent };
  } catch (error) {
    refreshIfUnavailable(queryClient)(error as Error);
    throw error;
  }
};

export const useStartThread = (agentId: AgentId) => {
  const queryClient = useQueryClient();
  return useMutation({ mutationFn: (content: string) => startThread(queryClient, agentId, content) });
};

/**
 * Switches a thread's brain from its next turn (ADR 017). The thread shows its new brain now; with
 * `makeDefault` the hob changes too, and the hob list hears of its new version from its event.
 */
export const useSetBrain = (agentId: AgentId, threadId: ThreadId) => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: SetBrainPayload) => call((c) => c.threads.setBrain({ params: { threadId }, payload })),
    onSuccess: (thread, payload) => {
      queryClient.setQueryData<ReadonlyArray<Thread>>(queryKeys.threads(agentId), (old) =>
        old
          ? sortThreads(
              upsertById(
                old,
                newer(
                  old.find((t) => t.id === thread.id),
                  thread,
                ),
              ),
            )
          : old,
      );
      if (payload.makeDefault) void queryClient.invalidateQueries({ queryKey: queryKeys.agents });
    },
  });
};

/** The brain a thread thinks with: its own, else its hob's. */
export const threadBrain = (hob: Agent, thread: Thread | undefined): Brain =>
  thread?.brain ?? { runtime: hob.runtime, model: hob.model, effort: hob.effort };

/** Continues a reply that was cut off or hit a limit, in the same message. */
export const useContinueReply = (threadId: ThreadId) => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (messageId: MessageId) => call((c) => c.threads.continueReply({ params: { threadId, messageId } })),
    onError: refreshIfUnavailable(queryClient),
    onSuccess: (message) => {
      queryClient.setQueryData<ReadonlyArray<Message>>(queryKeys.messages(threadId), (old) =>
        // A live event may already have brought a newer version of the reply.
        old
          ? upsertMessage(
              old,
              newer(
                old.find((m) => m.id === message.id),
                message,
              ),
            )
          : old,
      );
    },
  });
};
