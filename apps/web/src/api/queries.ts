import type { CreateAgentPayload, UpdateAgentPayload } from "@hobbots/api";
import type { Agent, AgentId, Message, MessageId, RetireWork, RuntimeKind, Thread, ThreadId } from "@hobbots/domain";
import { type QueryClient, queryOptions, useMutation, useQueryClient } from "@tanstack/react-query";
import { ApiError, call } from "./client.ts";
import { runtimeStaleTime } from "./runtime-health.ts";
import { syncedAgents, syncedMessages, syncedThreads } from "./sync.ts";

export const queryKeys = {
  agents: ["agents"] as const,
  archivedAgents: ["archivedAgents"] as const,
  threads: (agentId: AgentId) => ["agents", agentId, "threads"] as const,
  messages: (threadId: ThreadId) => ["threads", threadId, "messages"] as const,
  runtimes: ["runtimes"] as const,
  models: (runtime: RuntimeKind) => ["runtimes", runtime, "models"] as const,
};

/** The hobs that are not retired. */
export const agentsQuery = queryOptions({
  queryKey: queryKeys.agents,
  queryFn: syncedAgents(() => call((c) => c.agents.list({ query: {} })), false),
});

/** Archived hobs: the retired ones, most recently retired first. */
export const archivedAgentsQuery = queryOptions({
  queryKey: queryKeys.archivedAgents,
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
    queryFn: syncedThreads(agentId, () => call((c) => c.agents.threads({ params: { agentId } })), sortThreads),
  });

export const messagesQuery = (threadId: ThreadId) =>
  queryOptions({
    queryKey: queryKeys.messages(threadId),
    queryFn: syncedMessages(threadId, () => call((c) => c.threads.messages({ params: { threadId } })), upsertMessage),
  });

export const runtimesQuery = queryOptions({
  queryKey: queryKeys.runtimes,
  queryFn: () => call((c) => c.system.runtimes()),
  // Coming back from installing or updating Claude Code in a terminal checks again.
  staleTime: (query) => runtimeStaleTime(query.state.data),
  refetchOnWindowFocus: true,
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
 * Writes a hob the hub returned into the hob list now rather than waiting for the live event. A
 * retired hob leaves the list, as the server's list leaves it out.
 */
const useHobChange = <V>(change: (variables: V) => Promise<Agent>) => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: change,
    onSuccess: (hob) =>
      queryClient.setQueryData<ReadonlyArray<Agent>>(queryKeys.agents, (old) =>
        hob.status === "retired" ? old?.filter((h) => h.id !== hob.id) : upsertById(old, hob),
      ),
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
export const insertIfMissing = <T extends { readonly id: string }>(
  list: ReadonlyArray<T> | undefined,
  item: T | null,
) => (item === null || list?.some((existing) => existing.id === item.id) ? [...(list ?? [])] : upsertById(list, item));

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

export const sortThreads = (threads: Array<Thread>) => threads.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

/**
 * A hob that refused a message was paused or retired where this client has not heard yet, so the
 * hob list is fetched again and the chat shows why.
 */
const refreshIfUnavailable = (queryClient: QueryClient) => (error: Error) => {
  if (error instanceof ApiError && error.tag === "HobUnavailable")
    void queryClient.invalidateQueries({ queryKey: queryKeys.agents, exact: true });
};

export const useSendPrompt = (threadId: ThreadId) => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (content: string) => call((c) => c.threads.sendPrompt({ params: { threadId }, payload: { content } })),
    onError: refreshIfUnavailable(queryClient),
    onSuccess: ({ userMessage, assistantMessage }) => {
      queryClient.setQueryData<ReadonlyArray<Message>>(queryKeys.messages(threadId), (old) =>
        insertIfMissing(insertIfMissing(old, userMessage), assistantMessage),
      );
    },
  });
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

/** Creates a thread and sends its first prompt, so a new thread only appears once it has a message. */
export const useStartThread = (agentId: AgentId) => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (content: string) => {
      const thread = await call((c) => c.agents.createThread({ params: { agentId } }));
      // An empty list lets live events for the first reply land while the prompt is sent.
      queryClient.setQueryData<ReadonlyArray<Message>>(queryKeys.messages(thread.id), []);
      const sent = await call((c) => c.threads.sendPrompt({ params: { threadId: thread.id }, payload: { content } }));
      return { thread, ...sent };
    },
    onError: refreshIfUnavailable(queryClient),
    onSuccess: ({ thread, userMessage, assistantMessage }) => {
      queryClient.setQueryData<ReadonlyArray<Thread>>(queryKeys.threads(agentId), (old) =>
        sortThreads(insertIfMissing(old, thread)),
      );
      queryClient.setQueryData<ReadonlyArray<Message>>(queryKeys.messages(thread.id), (old) =>
        insertIfMissing(insertIfMissing(old, userMessage), assistantMessage),
      );
    },
  });
};
