import type {
  CreateAgentPayload,
  HobPermissions,
  RetireAgentPayload,
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
  RuntimeKind,
  SummonCaps,
  ChannelId,
  UsagePeriod,
} from "@hobbots/domain";
import { authorOf, messagePreview, sameActor, Channel } from "@hobbots/domain";
import {
  keepPreviousData,
  type QueryClient,
  queryOptions,
  useIsMutating,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import { periodStart } from "../lib/usage.ts";
import { ApiError, call } from "./client.ts";
import { runtimeRefetchOnFocus } from "./runtime-health.ts";
import { newer, syncedAgents, syncedMessages, syncedChannels } from "./sync.ts";

export const queryKeys = {
  agents: ["agents"] as const,
  archivedAgents: ["archivedAgents"] as const,
  channels: (agentId: AgentId) => ["agents", agentId, "channels"] as const,
  archivedChannels: (agentId: AgentId) => ["agents", agentId, "archivedChannels"] as const,
  messages: (channelId: ChannelId) => ["channels", channelId, "messages"] as const,
  unreadChannels: ["unreadChannels"] as const,
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

export const channelsQuery = (agentId: AgentId) =>
  queryOptions({
    queryKey: queryKeys.channels(agentId),
    ...followsEvents,
    queryFn: syncedChannels(
      agentId,
      () => call((c) => c.agents.channels({ params: { agentId }, query: {} })),
      sortChannels,
      false,
    ),
  });

/** A hob's archived channels, most recently archived first. */
export const archivedChannelsQuery = (agentId: AgentId) =>
  queryOptions({
    queryKey: queryKeys.archivedChannels(agentId),
    ...followsEvents,
    queryFn: syncedChannels(
      agentId,
      () => call((c) => c.agents.channels({ params: { agentId }, query: { archived: "true" } })),
      sortArchivedChannels,
      true,
    ),
  });

export const messagesQuery = (channelId: ChannelId) =>
  queryOptions({
    queryKey: queryKeys.messages(channelId),
    ...followsEvents,
    queryFn: syncedMessages(channelId, () => call((c) => c.channels.messages({ params: { channelId } })), upsertMessage),
  });

export const runtimesQuery = queryOptions({
  queryKey: queryKeys.runtimes,
  queryFn: () => call((c) => c.system.runtimes()),
  // Each check runs the providers' CLIs, so opening a page or a channel doesn't check again.
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
export const useHobChange = <V>(change: (variables: V) => Promise<Agent>) => {
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

/**
 * Retires a hob, or has it finish its open Tasks first (#408): its replies finish or stop, its open
 * Tasks may go to another hob, and nothing is deleted.
 */
export const useRetireHob = (agentId: AgentId) =>
  useHobChange((payload: RetireAgentPayload) => call((c) => c.agents.retire({ params: { agentId }, payload })));

/**
 * What the hob still has open, which Retire lists (#408), each Task checked against `handOverTo`
 * when one is picked. Read each time Retire opens, since work moves on while it is closed.
 */
export const openWorkQuery = (agentId: AgentId, handOverTo: AgentId | null) =>
  queryOptions({
    queryKey: ["agents", agentId, "openWork", handOverTo] as const,
    queryFn: () =>
      call((c) => c.agents.openWork({ params: { agentId }, query: handOverTo === null ? {} : { handOverTo } })),
    staleTime: 0,
    placeholderData: keepPreviousData,
  });

/** Brings a retired hob back, active with all its chats. */
export const useBringBackHob = () =>
  useHobChange((agentId: AgentId) => call((c) => c.agents.bringBack({ params: { agentId } })));

/** Retires a hob again after it was brought back by mistake; replies it started finish. */
export const useRetireAgain = () =>
  useHobChange((agentId: AgentId) =>
    call((c) => c.agents.retire({ params: { agentId }, payload: { activeWork: "finish" } })),
  );

/**
 * A hob's live hobs summoned without asking you, against the caps on them (ADR 034). The count
 * changes as the hob summons or retires hobs, so `basis` names the hobs it summoned, from the hob
 * list the hub's events keep current, and a change to them reads it again.
 */
export const summonCapsQuery = (agentId: AgentId, basis: ReadonlyArray<unknown>) =>
  queryOptions({
    queryKey: ["summon-caps", agentId, ...basis],
    queryFn: () => call((c) => c.agents.summonCaps({ params: { agentId } })),
    placeholderData: (previous: SummonCaps | undefined) => previous,
  });

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
/** The key of a hob's permissions changes, so any view can tell one is still saving (STD-REACT-001). */
const updatePermissionsKey = (agentId: AgentId) => ["permissions", "update", agentId] as const;

/** Whether a change to the hob's permissions is still saving, from any view. */
export const useSavingPermissions = (agentId: AgentId) =>
  useIsMutating({ mutationKey: updatePermissionsKey(agentId) }) > 0;

export const useUpdatePermissions = (agentId: AgentId) => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: updatePermissionsKey(agentId),
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

const sortChannels = (channels: Array<Channel>) => channels.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

const sortArchivedChannels = (channels: Array<Channel>) =>
  channels.sort((a, b) => (b.archivedAt ?? "").localeCompare(a.archivedAt ?? ""));

/**
 * Puts a channel the hub returned or announced in its hob's list by its `archivedAt`: a live channel in
 * the channel list, an archived one in the archived list, and out of the other. An older version than
 * the one already shown changes nothing. Lists not loaded yet stay unloaded.
 */
export const placeChannel = (queryClient: QueryClient, channel: Channel) => {
  const archived = channel.archivedAt !== null;
  const known = [queryKeys.channels(channel.ownerHobId), queryKeys.archivedChannels(channel.ownerHobId)]
    .flatMap((key) => queryClient.getQueryData<ReadonlyArray<Channel>>(key) ?? [])
    .find((existing) => existing.id === channel.id);
  if (newer(known, channel) !== channel) return;
  const into = archived ? queryKeys.archivedChannels(channel.ownerHobId) : queryKeys.channels(channel.ownerHobId);
  const outOf = archived ? queryKeys.channels(channel.ownerHobId) : queryKeys.archivedChannels(channel.ownerHobId);
  const order = archived ? sortArchivedChannels : sortChannels;
  queryClient.setQueryData<ReadonlyArray<Channel>>(into, (old) => (old ? order(upsertById(old, channel)) : old));
  queryClient.setQueryData<ReadonlyArray<Channel>>(outOf, (old) => old?.filter((t) => t.id !== channel.id));
};

const isChannelList = (query: { readonly queryKey: ReadonlyArray<unknown> }) =>
  query.queryKey[0] === "agents" && /^(channels|archivedChannels)$/.test(String(query.queryKey[2]));

/**
 * A message the transcript shows becomes its channel's last line in the hob's channel lists, so a
 * list of chats follows a reply as it lands. The hub works out the same line when it reads them.
 */
export const showLastLine = (queryClient: QueryClient, message: Message) => {
  const lists = queryClient.getQueriesData<ReadonlyArray<Channel>>({ predicate: isChannelList });
  if (message.quiet) {
    // A reply kept quiet as it completes may already be the last line, from a read or a step while it
    // streamed. The hub reads the line from the message before it, so the lists holding the channel
    // are read again (#1006).
    for (const [key, channels] of lists)
      if (channels?.some((channel) => channel.id === message.channelId))
        void queryClient.invalidateQueries({ queryKey: key, exact: true });
    return;
  }
  const lastLine = messagePreview(message);
  if (lastLine === null) return;
  // Who wrote it, as the hub reads it with the line: the message's own actor (STD-ARCH-021).
  const shown = (channel: Channel) => {
    const lastAuthor = authorOf(message, channel);
    const sameAuthor =
      channel.lastAuthor === null || lastAuthor === null
        ? channel.lastAuthor === lastAuthor
        : sameActor(channel.lastAuthor, lastAuthor);
    return channel.lastLine === lastLine && sameAuthor ? channel : new Channel({ ...channel, lastLine, lastAuthor });
  };
  for (const [key, channels] of lists) {
    if (!channels?.some((channel) => channel.id === message.channelId && shown(channel) !== channel)) continue;
    queryClient.setQueryData<ReadonlyArray<Channel>>(key, (old) =>
      old?.map((channel) => (channel.id === message.channelId ? shown(channel) : channel)),
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

/** Sends a prompt and puts it and its reply in the channel, without a component to report to. */
export const sendPrompt = async (queryClient: QueryClient, channelId: ChannelId, content: string) => {
  try {
    const sent = await call((c) => c.channels.sendPrompt({ params: { channelId }, payload: { content } }));
    queryClient.setQueryData<ReadonlyArray<Message>>(queryKeys.messages(channelId), (old) =>
      insertIfMissing(insertIfMissing(old, sent.userMessage), sent.assistantMessage),
    );
    return sent;
  } catch (error) {
    refreshIfUnavailable(queryClient)(error as Error);
    throw error;
  }
};

export const useSendPrompt = (channelId: ChannelId) => {
  const queryClient = useQueryClient();
  return useMutation({ mutationFn: (content: string) => sendPrompt(queryClient, channelId, content) });
};

/** Takes a queued message out of the channel before it starts. */
export const useRemoveQueued = (channelId: ChannelId) => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (messageId: MessageId) => call((c) => c.channels.removeQueued({ params: { channelId, messageId } })),
    onSuccess: (_, messageId) => {
      queryClient.setQueryData<ReadonlyArray<Message>>(queryKeys.messages(channelId), (old) =>
        old?.filter((message) => message.id !== messageId),
      );
    },
  });
};

/** Stops the running reply and starts this queued message next. */
export const useSendNow = (channelId: ChannelId) =>
  useMutation({
    mutationFn: (messageId: MessageId) => call((c) => c.channels.sendNow({ params: { channelId, messageId } })),
  });

export const useInterrupt = (channelId: ChannelId) =>
  useMutation({
    mutationFn: () => call((c) => c.channels.interrupt({ params: { channelId } })),
  });

/** Stop waiting: ends a reply that only waits on commands, keeping its text (#1056). */
export const useStopWaiting = (channelId: ChannelId) =>
  useMutation({
    mutationFn: () => call((c) => c.channels.stopWaiting({ params: { channelId } })),
  });

/**
 * Let them go on (ADR 039): the hobs the relay budget paused in the channel go on. The card goes
 * away when the hub publishes the channel's run without them.
 */
export const useLetHobsGoOn = (channelId: ChannelId) =>
  useMutation({
    mutationFn: () => call((c) => c.channels.letHobsGoOn({ params: { channelId } })),
  });

/** Creates a channel and sends its first prompt, so a new channel only appears once it has a message. */
export const startChannel = async (queryClient: QueryClient, agentId: AgentId, content: string) => {
  try {
    const channel = await call((c) => c.agents.createChannel({ params: { agentId } }));
    // An empty list lets live events for the first reply land while the prompt is sent.
    queryClient.setQueryData<ReadonlyArray<Message>>(queryKeys.messages(channel.id), []);
    const sent = await call((c) => c.channels.sendPrompt({ params: { channelId: channel.id }, payload: { content } }));
    queryClient.setQueryData<ReadonlyArray<Channel>>(queryKeys.channels(agentId), (old) =>
      sortChannels(insertIfMissing(old, channel)),
    );
    queryClient.setQueryData<ReadonlyArray<Message>>(queryKeys.messages(channel.id), (old) =>
      insertIfMissing(insertIfMissing(old, sent.userMessage), sent.assistantMessage),
    );
    return { channel, ...sent };
  } catch (error) {
    refreshIfUnavailable(queryClient)(error as Error);
    throw error;
  }
};

export const useStartChannel = (agentId: AgentId) => {
  const queryClient = useQueryClient();
  return useMutation({ mutationFn: (content: string) => startChannel(queryClient, agentId, content) });
};

/**
 * Switches a channel's brain from its next turn (ADR 017). The channel shows its new brain now; with
 * `makeDefault` the hob changes too, and the hob list hears of its new version from its event.
 */
export const useSetBrain = (agentId: AgentId, channelId: ChannelId) => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: SetBrainPayload) => call((c) => c.channels.setBrain({ params: { channelId }, payload })),
    onSuccess: (channel, payload) => {
      queryClient.setQueryData<ReadonlyArray<Channel>>(queryKeys.channels(agentId), (old) =>
        old
          ? sortChannels(
              upsertById(
                old,
                newer(
                  old.find((t) => t.id === channel.id),
                  channel,
                ),
              ),
            )
          : old,
      );
      if (payload.makeDefault) void queryClient.invalidateQueries({ queryKey: queryKeys.agents });
    },
  });
};

/** The brain a channel thinks with: its own, else its hob's. */
export const channelBrain = (hob: Agent, channel: Channel | undefined): Brain =>
  channel?.brain ?? { runtime: hob.runtime, model: hob.model, effort: hob.effort };

/** Continues a reply that was cut off or hit a limit, in the same message. */
export const useContinueReply = (channelId: ChannelId) => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (messageId: MessageId) => call((c) => c.channels.continueReply({ params: { channelId, messageId } })),
    onError: refreshIfUnavailable(queryClient),
    onSuccess: (message) => {
      queryClient.setQueryData<ReadonlyArray<Message>>(queryKeys.messages(channelId), (old) =>
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
