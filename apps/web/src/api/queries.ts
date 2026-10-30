import type { CreateAgentPayload } from "@hobbots/api";
import type { Agent, AgentId, Message, RuntimeKind, Thread, ThreadId } from "@hobbots/domain";
import { queryOptions, useMutation, useQueryClient } from "@tanstack/react-query";
import { call } from "./client.ts";
import { runtimeStaleTime } from "./runtime-health.ts";

export const queryKeys = {
  agents: ["agents"] as const,
  threads: (agentId: AgentId) => ["agents", agentId, "threads"] as const,
  messages: (threadId: ThreadId) => ["threads", threadId, "messages"] as const,
  runtimes: ["runtimes"] as const,
  models: (runtime: RuntimeKind) => ["runtimes", runtime, "models"] as const,
};

export const agentsQuery = queryOptions({
  queryKey: queryKeys.agents,
  queryFn: () => call((c) => c.agents.list()),
});

export const threadsQuery = (agentId: AgentId) =>
  queryOptions({
    queryKey: queryKeys.threads(agentId),
    queryFn: () => call((c) => c.agents.threads({ params: { agentId } })),
  });

export const messagesQuery = (threadId: ThreadId) =>
  queryOptions({
    queryKey: queryKeys.messages(threadId),
    queryFn: () => call((c) => c.threads.messages({ params: { threadId } })),
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

/** Adds an item unless a live event already delivered it (possibly newer). */
export const insertIfMissing = <T extends { readonly id: string }>(list: ReadonlyArray<T> | undefined, item: T) =>
  list?.some((existing) => existing.id === item.id) ? [...list] : upsertById(list, item);

export const sortThreads = (threads: Array<Thread>) => threads.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

export const useSendPrompt = (threadId: ThreadId) => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (content: string) => call((c) => c.threads.sendPrompt({ params: { threadId }, payload: { content } })),
    onSuccess: ({ userMessage, assistantMessage }) => {
      queryClient.setQueryData<ReadonlyArray<Message>>(queryKeys.messages(threadId), (old) =>
        insertIfMissing(insertIfMissing(old, userMessage), assistantMessage),
      );
    },
  });
};

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
