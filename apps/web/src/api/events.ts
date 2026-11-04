import {
  type Agent,
  CommandOutput,
  EVENT_SCHEMA_VERSIONS,
  EventEnvelope,
  type HobbotsEvent,
  isInProgress,
  type Message,
  MessageDelta,
  RemoteAccessChanged,
  type RemoteAccessStatus,
  STREAM_FRAME,
  StreamReady,
} from "@hobbots/domain";
import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { Schema } from "effect";
import { useEffect, useState } from "react";
import { recordActivity, setActivity } from "./activity.ts";
import { storeApproval } from "./approvals.ts";
import { storeBackpackItem } from "./backpack.ts";
import { API_URL } from "./client.ts";
import { devicesChanged } from "./devices.ts";
import { grantsChanged } from "./grants.ts";
import { applyHistory } from "./history.ts";
import type { ConnectionState } from "./live.ts";
import { probeAccess, setConnection, setDeviceAccess } from "./live.ts";
import { attachOutbox, connectionChanged } from "./outbox.ts";
import { pairingChanged } from "./pairing.ts";
import { placeThread, queryKeys, showLastLine, sortArchived, upsertById, upsertMessage } from "./queries.ts";
import { applyQuestWork } from "./quest-work.ts";
import { questionChanged, workEnded } from "./questions.ts";
import { applyRemoteAccess, remoteAccessQuery } from "./remote-access.ts";
import {
  newer,
  recordAgent,
  recordMessage,
  recordRemovedMessage,
  recordThread,
  startGeneration,
  syncState,
} from "./sync.ts";
import type { TaskEvent } from "./task-trees.ts";
import { applyTaskEvent } from "./tasks.ts";
import { activityChanged, applyCommandOutput, recordedAttempt } from "./workbench.ts";

const decodeEntry = Schema.decodeUnknownSync(Schema.fromJsonString(EventEnvelope));
const decodeReady = Schema.decodeUnknownSync(Schema.fromJsonString(StreamReady));
const decodeDelta = Schema.decodeUnknownSync(Schema.fromJsonString(MessageDelta));
const decodeRemoteAccess = Schema.decodeUnknownSync(Schema.fromJsonString(RemoteAccessChanged));
const decodeCommandOutput = Schema.decodeUnknownSync(Schema.fromJsonString(CommandOutput));

/** How long a stream the hub closed waits before it opens again. */
const REOPEN_AFTER_MS = 2000;

/** Replaces an entity in a list unless the list already holds a newer version of it. */
const upsertNewer = <T extends { readonly id: string; readonly revision: number }>(
  list: ReadonlyArray<T>,
  item: T,
  upsert: (list: ReadonlyArray<T>, item: T) => Array<T> = upsertById,
) => {
  const known = list.find((existing) => existing.id === item.id);
  const kept = newer(known, item);
  return kept === known ? [...list] : upsert(list, kept);
};

/**
 * Applies a reply chunk by its offset, so a repeated chunk changes nothing. A chunk that starts past
 * the end of the text means some were missed: the thread's messages are fetched again.
 */
const applyDelta = (queryClient: QueryClient, event: MessageDelta) => {
  let missed = false;
  queryClient.setQueryData<ReadonlyArray<Message>>(queryKeys.messages(event.threadId), (old) =>
    old?.map((message) => {
      if (message.id !== event.messageId || !isInProgress(message.status)) return message;
      const known = message.content.length;
      if (event.offset > known) {
        missed = true;
        return message;
      }
      const fresh = event.delta.slice(known - event.offset);
      return fresh.length === 0 ? message : ({ ...message, content: message.content + fresh } as Message);
    }),
  );
  if (missed) void queryClient.invalidateQueries({ queryKey: queryKeys.messages(event.threadId), exact: true });
  setActivity(queryClient, event.threadId, "working");
};

const applyAgent = (queryClient: QueryClient, hob: Agent) => {
  recordAgent(queryClient, hob);
  // The hob list leaves retired hobs out, as the server's list does.
  queryClient.setQueryData<ReadonlyArray<Agent>>(queryKeys.agents, (old) =>
    old === undefined
      ? old
      : hob.status === "retired"
        ? old.filter((agent) => agent.id !== hob.id)
        : upsertNewer(old, hob),
  );
  // A hob retired elsewhere joins the retired hobs, and one brought back leaves them.
  queryClient.setQueryData<ReadonlyArray<Agent>>(queryKeys.archivedAgents, (old) =>
    old === undefined
      ? old
      : hob.status === "retired"
        ? sortArchived(upsertNewer(old, hob))
        : old.filter((agent) => agent.id !== hob.id),
  );
};

type WorkbenchEvent = Extract<
  HobbotsEvent,
  {
    readonly _tag:
      | "CommandRecorded"
      | "FileChangesRecorded"
      | "FolderScanned"
      | "AttemptStepsRecorded"
      | "CommandOutput";
  }
>;
const isWorkbenchEvent = (event: HobbotsEvent): event is WorkbenchEvent =>
  event._tag === "CommandOutput" || recordedAttempt(event) !== null;

/** A recorded command, file change or scan reads its Attempt's records again; a running command's output is kept as it comes. */
const applyWorkbenchEvent = (queryClient: QueryClient, event: WorkbenchEvent) => {
  if (event._tag === "CommandOutput") {
    applyCommandOutput(queryClient, event);
    return;
  }
  const attemptId = recordedAttempt(event);
  if (attemptId !== null) void activityChanged(queryClient, attemptId);
};

/**
 * Applies an event to the Query cache and records what it changed in the sync generation's overlay.
 * Lists are only patched once loaded; creating a partial list here would hide the rest of it.
 */
export const applyEvent = (queryClient: QueryClient, event: HobbotsEvent) => {
  applyQuestWork(queryClient, event);
  applyHistory(queryClient, event);
  // An Attempt's commands, file changes and scans (ADR 023) read its records again in the Workbench.
  // A running command's output is transient; the Terminal follows it.
  if (isWorkbenchEvent(event)) {
    applyWorkbenchEvent(queryClient, event);
    return;
  }
  switch (event._tag) {
    case "AgentUpserted":
      applyAgent(queryClient, event.agent);
      return;
    case "ThreadUpserted":
      recordThread(queryClient, event.thread);
      // A thread archived or restored elsewhere moves between the hob's two lists.
      placeThread(queryClient, event.thread);
      return;
    case "MessageUpserted":
      recordMessage(queryClient, event.message);
      queryClient.setQueryData<ReadonlyArray<Message>>(queryKeys.messages(event.message.threadId), (old) =>
        old ? upsertNewer(old, event.message, upsertMessage) : old,
      );
      if (event.message.role === "assistant") recordActivity(queryClient, event.message);
      showLastLine(queryClient, event.message);
      return;
    // The message itself arrives as MessageUpserted just before.
    case "MessageQueued":
      return;
    case "MessageDequeued":
      if (event.reason === "removed") {
        recordRemovedMessage(queryClient, event.messageId);
        queryClient.setQueryData<ReadonlyArray<Message>>(queryKeys.messages(event.threadId), (old) =>
          old?.filter((message) => message.id !== event.messageId),
        );
      }
      return;
    case "MessageDelta":
      applyDelta(queryClient, event);
      return;
    // The reply's own upsert, sent just before, already carries its stopping or stopped status.
    case "TurnStopRequested":
    case "TurnStopped":
      return;
    // Chat shows what a reply is doing from the reply itself, so the window does not follow `turn` frames.
    case "TurnStarted":
    case "TurnEnded":
      return;
    default:
      applyWorkEvent(queryClient, event);
      return;
  }
};

/** Approvals, grants, backpack items, devices, and the events that change Tasks and Quests. */
const applyWorkEvent = (
  queryClient: QueryClient,
  event:
    | TaskEvent
    | Extract<
        HobbotsEvent,
        {
          readonly _tag:
            | "ApprovalRequested"
            | "ApprovalResolved"
            | "GrantCreated"
            | "GrantRevoked"
            | "BackpackItemRecorded"
            | "BackpackItemChanged"
            | "PairingRequested"
            | "PairingChanged"
            | "DeviceRevoked";
        }
      >,
) => {
  switch (event._tag) {
    case "ApprovalRequested":
    case "ApprovalResolved":
      storeApproval(queryClient, event.approval);
      return;
    case "GrantCreated":
    case "GrantRevoked":
      void grantsChanged(queryClient);
      return;
    // What hobs are waiting on, and what is stuck (ADR 019, IN-007).
    case "BackpackItemRecorded":
    case "BackpackItemChanged":
      storeBackpackItem(queryClient, event.item);
      return;
    // A device asked to pair, or its request was decided (ADR 021).
    case "PairingRequested":
      void pairingChanged(queryClient);
      return;
    // A decided request may have added a device to the list.
    case "PairingChanged":
      void pairingChanged(queryClient);
      void devicesChanged(queryClient);
      return;
    // Any list of devices is read again. This device's own removal shows when the hub refuses it.
    case "DeviceRevoked":
      void devicesChanged(queryClient);
      return;
    case "TaskStateChanged":
    case "TaskCompleted":
      applyTaskEvent(queryClient, event);
      void workEnded(queryClient, event.task);
      return;
    // The rest change Tasks and Quests (ADR 018). A question that reaches you, or leaves you, also
    // changes what waits in your Inbox.
    default:
      applyTaskEvent(queryClient, event);
      if ("question" in event) void questionChanged(queryClient, event.question);
      return;
  }
};

/**
 * Takes a change of remote access the hub announced. Its event is not replayed, so nothing would
 * correct an older answer that lands after it: a read already on its way, such as the one a fresh
 * stream starts, is cancelled first.
 */
export const remoteAccessChanged = (queryClient: QueryClient, status: RemoteAccessStatus) => {
  void queryClient.cancelQueries({ queryKey: remoteAccessQuery.queryKey, exact: true });
  applyRemoteAccess(queryClient, status);
};

/** True when this client knows how to read the entry: its type and payload version. */
const understands = (entry: EventEnvelope) =>
  entry.type in EVENT_SCHEMA_VERSIONS &&
  entry.schemaVersion <= EVENT_SCHEMA_VERSIONS[entry.type as keyof typeof EVENT_SCHEMA_VERSIONS];

/**
 * Subscribes to server events and writes them into the Query cache. The stream resumes from the
 * last cursor received (the browser sends it as `Last-Event-ID` when it reconnects), so a
 * reconnect replays what was missed instead of refetching everything. A fresh `Ready` (a first
 * connection, or a cursor the hub can no longer replay) starts a new sync generation.
 *
 * The browser retries a dropped stream on its own; `retry` opens a new one now.
 */
export const useHobbotsEvents = (): { state: ConnectionState; retry: () => void } => {
  const queryClient = useQueryClient();
  const [state, setState] = useState<ConnectionState>("connecting");
  const [attempt, setAttempt] = useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: a new attempt opens a new stream.
  useEffect(() => {
    const report = (next: ConnectionState) => {
      setState(next);
      setConnection(queryClient, next);
      connectionChanged(next);
    };
    attachOutbox(queryClient);
    const sync = syncState(queryClient);
    const after = sync.cursor === undefined ? "" : `?after=${encodeURIComponent(sync.cursor)}`;
    const source = new EventSource(`${API_URL}/api/events${after}`);
    source.addEventListener(STREAM_FRAME.ready, (frame) => {
      try {
        const ready = decodeReady(frame.data);
        sync.cursor = ready.cursor;
        if (!ready.resumed) startGeneration(queryClient);
        setDeviceAccess(queryClient, "approved");
        report("live");
      } catch (error) {
        console.warn("Ignoring malformed event", error);
      }
    });
    source.onmessage = (frame) => {
      sync.cursor = frame.lastEventId;
      let entry: EventEnvelope;
      try {
        entry = decodeEntry(frame.data);
      } catch {
        // An event this client cannot read, as after the hub was upgraded: refetch rather than guess.
        startGeneration(queryClient);
        return;
      }
      if (understands(entry)) applyEvent(queryClient, entry.payload);
      else startGeneration(queryClient);
    };
    source.addEventListener(STREAM_FRAME.delta, (frame) => {
      try {
        applyDelta(queryClient, decodeDelta(frame.data));
      } catch (error) {
        console.warn("Ignoring malformed event", error);
      }
    });
    source.addEventListener(STREAM_FRAME.commandOutput, (frame) => {
      try {
        applyCommandOutput(queryClient, decodeCommandOutput(frame.data));
      } catch (error) {
        console.warn("Ignoring malformed event", error);
      }
    });
    source.addEventListener(STREAM_FRAME.remoteAccess, (frame) => {
      try {
        remoteAccessChanged(queryClient, decodeRemoteAccess(frame.data).status);
      } catch (error) {
        console.warn("Ignoring malformed event", error);
      }
    });
    // "Reconnecting" lasts until the next Ready. A refusal, as when the hub started again with a new
    // key, closes the stream for good, so it opens again a moment later with the cookie set anew.
    // Every drop also asks the hub why, so a revoked device or a hub out of reach says so at once.
    let reopen: ReturnType<typeof setTimeout> | undefined;
    source.onerror = () => {
      report("reconnecting");
      void probeAccess(queryClient);
      if (source.readyState === EventSource.CLOSED && reopen === undefined) {
        reopen = setTimeout(() => setAttempt((n) => n + 1), REOPEN_AFTER_MS);
      }
    };
    return () => {
      clearTimeout(reopen);
      source.close();
    };
  }, [queryClient, attempt]);

  return { state, retry: () => setAttempt((n) => n + 1) };
};
