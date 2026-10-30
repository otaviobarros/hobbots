import { type Agent, HobbotsEvent, type Message, type Thread } from "@hobbots/domain";
import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { Schema } from "effect";
import { useEffect, useState } from "react";
import { recordActivity, setActivity } from "./activity.ts";
import { API_URL } from "./client.ts";
import { queryKeys, sortArchived, sortThreads, upsertById } from "./queries.ts";

const decodeEvent = Schema.decodeUnknownSync(Schema.fromJsonString(HobbotsEvent));

// Lists are only patched once loaded; creating a partial list here would hide the rest of it.
export const applyEvent = (queryClient: QueryClient, event: HobbotsEvent) => {
  switch (event._tag) {
    case "AgentUpserted":
      // The hob list leaves retired hobs out, as the server's list does.
      queryClient.setQueryData<ReadonlyArray<Agent>>(queryKeys.agents, (old) =>
        old === undefined
          ? old
          : event.agent.status === "retired"
            ? old.filter((agent) => agent.id !== event.agent.id)
            : upsertById(old, event.agent),
      );
      // A hob retired elsewhere joins Archived hobs.
      if (event.agent.status === "retired") {
        queryClient.setQueryData<ReadonlyArray<Agent>>(queryKeys.archivedAgents, (old) =>
          old === undefined ? old : sortArchived(upsertById(old, event.agent)),
        );
      }
      return;
    case "ThreadUpserted":
      queryClient.setQueryData<ReadonlyArray<Thread>>(queryKeys.threads(event.thread.agentId), (old) =>
        old ? sortThreads(upsertById(old, event.thread)) : old,
      );
      return;
    case "MessageUpserted":
      queryClient.setQueryData<ReadonlyArray<Message>>(queryKeys.messages(event.message.threadId), (old) =>
        old ? upsertById(old, event.message) : old,
      );
      if (event.message.role === "assistant") recordActivity(queryClient, event.message);
      return;
    case "MessageDelta":
      queryClient.setQueryData<ReadonlyArray<Message>>(queryKeys.messages(event.threadId), (old) =>
        old?.map((message) =>
          message.id === event.messageId && message.status === "streaming"
            ? ({
                ...message,
                content: message.content + event.delta,
              } as Message)
            : message,
        ),
      );
      setActivity(queryClient, event.threadId, "working");
      return;
  }
};

export type ConnectionState = "connecting" | "live" | "reconnecting";

/** Subscribes to server events and writes them into the Query cache. */
export const useHobbotsEvents = (): ConnectionState => {
  const queryClient = useQueryClient();
  const [state, setState] = useState<ConnectionState>("connecting");

  useEffect(() => {
    const source = new EventSource(`${API_URL}/api/events`);
    let opened = false;
    source.onopen = () => {
      // Events are not replayed yet, so refetch after a reconnect to close any gap.
      if (opened) void queryClient.invalidateQueries();
      opened = true;
      setState("live");
    };
    source.onerror = () => setState("reconnecting");
    source.onmessage = (message) => {
      try {
        applyEvent(queryClient, decodeEvent(message.data));
      } catch (error) {
        console.warn("Ignoring malformed event", error);
      }
    };
    return () => source.close();
  }, [queryClient]);

  return state;
};
