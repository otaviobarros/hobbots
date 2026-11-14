import {
  type Agent,
  CommandOutput,
  EVENT_SCHEMA_VERSIONS,
  EventEnvelope,
  type HobbotsEvent,
  isInProgress,
  MemoryChanged,
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
import { moveApproval, storeApproval } from "./approvals.ts";
import { storeBackpackItem } from "./backpack.ts";
import { applySuggestionEvent, isSuggestionEvent } from "./camp-suggestions.ts";
import { chapterMoved, chatStartedFresh } from "./camps.ts";
import { applyChapterEvent } from "./chapters.ts";
import { applyClaimEvent, type ClaimEvent, isClaimEvent } from "./clashes.ts";
import { API_URL } from "./client.ts";
import { devicesChanged } from "./devices.ts";
import { failedTaskChanged } from "./failed-tasks.ts";
import { grantsChanged } from "./grants.ts";
import { applyHistory } from "./history.ts";
import { applyHobChanges } from "./hob-changes.ts";
import { hobProposalsChanged } from "./hob-proposals.ts";
import { hobSkillsChanged } from "./hob-skills.ts";
import { hubQuestionChanged } from "./hub-questions.ts";
import { applyStatusFrame, statusReady } from "./hub-status.ts";
import type { ConnectionState } from "./live.ts";
import { probeAccess, setConnection, setDeviceAccess } from "./live.ts";
import { applyMemoryChanged, refreshMemory } from "./memory-pages.ts";
import { applyMemorySave, refreshMemorySaves } from "./memory-saves.ts";
import { memorySharesChanged } from "./memory-shares.ts";
import { applyPinEvent, isPinEvent } from "./notes.ts";
import { attachOutbox, connectionChanged } from "./outbox.ts";
import { pairingChanged } from "./pairing.ts";
import { placeThread, queryKeys, showLastLine, sortArchived, upsertById, upsertMessage } from "./queries.ts";
import { questSummaryChanged } from "./quest-summaries.ts";
import { applyQuestWork } from "./quest-work.ts";
import { questionChanged, workEnded } from "./questions.ts";
import { applyRecordEvent, isRecordEvent } from "./records.ts";
import { applyRemoteAccess, remoteAccessQuery } from "./remote-access.ts";
import { skillProposalsChanged } from "./skill-proposals.ts";
import { refreshSkillUpdates } from "./skill-updates.ts";
import { refreshSkillFeedback, refreshSkills, refreshSkillUses } from "./skills.ts";
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
import { showUnread, unreadChanged } from "./thread-reads.ts";
import { webChanged } from "./web.ts";
import { applyCommandOutput } from "./workbench.ts";

const decodeEntry = Schema.decodeUnknownSync(Schema.fromJsonString(EventEnvelope));
const decodeReady = Schema.decodeUnknownSync(Schema.fromJsonString(StreamReady));
const decodeDelta = Schema.decodeUnknownSync(Schema.fromJsonString(MessageDelta));
const decodeRemoteAccess = Schema.decodeUnknownSync(Schema.fromJsonString(RemoteAccessChanged));
const decodeCommandOutput = Schema.decodeUnknownSync(Schema.fromJsonString(CommandOutput));
const decodeMemoryChanged = Schema.decodeUnknownSync(Schema.fromJsonString(MemoryChanged));

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
const WORKBENCH_RECORDS: ReadonlySet<HobbotsEvent["_tag"]> = new Set([
  "CommandRecorded",
  "FileChangesRecorded",
  "FolderScanned",
  "AttemptStepsRecorded",
  "CommandOutput",
]);
const isWorkbenchEvent = (event: HobbotsEvent): event is WorkbenchEvent => WORKBENCH_RECORDS.has(event._tag);

/** Changes to the skills library, after which a hob's next turn may get other skills. */
const SKILL_LIBRARY_CHANGES: ReadonlySet<HobbotsEvent["_tag"]> = new Set([
  "SkillRevisionAdded",
  "SkillAssigned",
  "SkillUnassigned",
  "SkillRolledOut",
  "SkillHeld",
  "SkillOptOutChanged",
  "SkillRemoved",
]);

/** What the checks of Git sources found, and Update automatically: the Skills page's Updates reads them again. */
const SKILL_UPDATE_EVENTS: ReadonlySet<HobbotsEvent["_tag"]> = new Set([
  "SkillUpdateFound",
  "SkillUpdateDismissed",
  "SkillUpdateCleared",
  "SkillAutoUpdateChanged",
]);
type SkillUpdateEvent = Extract<
  HobbotsEvent,
  {
    readonly _tag: "SkillUpdateFound" | "SkillUpdateDismissed" | "SkillUpdateCleared" | "SkillAutoUpdateChanged";
  }
>;
const isSkillUpdateEvent = (event: HobbotsEvent): event is SkillUpdateEvent => SKILL_UPDATE_EVENTS.has(event._tag);
type SkillLibraryChange = Extract<
  HobbotsEvent,
  {
    readonly _tag:
      | "SkillRevisionAdded"
      | "SkillAssigned"
      | "SkillUnassigned"
      | "SkillRolledOut"
      | "SkillHeld"
      | "SkillOptOutChanged"
      | "SkillRemoved";
  }
>;
const isSkillLibraryChange = (event: HobbotsEvent): event is SkillLibraryChange =>
  SKILL_LIBRARY_CHANGES.has(event._tag);

/**
 * Library changes a proposal's review is drawn from: the newest revision it is shown against, and
 * the assignments adding it would roll out to.
 */
const REVIEWED_LIBRARY: ReadonlySet<HobbotsEvent["_tag"]> = new Set([
  "SkillRevisionAdded",
  "SkillAssigned",
  "SkillUnassigned",
  "SkillRolledOut",
  "SkillHeld",
  "SkillRemoved",
]);

/** Events the cache takes nothing from. */
const UNAPPLIED: ReadonlySet<HobbotsEvent["_tag"]> = new Set([
  // The reply's own upsert, sent just before, already carries its stopping or stopped status.
  "TurnStopRequested",
  "TurnStopped",
  // Chat shows what a reply is doing from the reply itself, so the window does not follow `turn` frames.
  "TurnStarted",
  "TurnEnded",
  // The status the hub decides comes on `status` frames, never as journal entries (ADR 037).
  "ThreadRunChanged",
  "HobPresenceChanged",
  "HobPresenceRemoved",
  // Nothing on screen shows members yet (ADR 039); a new member has read nothing.
  "ThreadMemberAdded",
]);
type UnappliedEvent = Extract<
  HobbotsEvent,
  {
    readonly _tag:
      | "TurnStopRequested"
      | "TurnStopped"
      | "TurnStarted"
      | "TurnEnded"
      | "ThreadRunChanged"
      | "HobPresenceChanged"
      | "HobPresenceRemoved"
      | "ThreadMemberAdded";
  }
>;
const isUnapplied = (event: HobbotsEvent): event is UnappliedEvent => UNAPPLIED.has(event._tag);

/** What hobs searched and read, and the limits on it: a chat's step lines, Usage and Settings › Web read them (ADR 036). */
const WEB_EVENTS: ReadonlySet<HobbotsEvent["_tag"]> = new Set([
  "WebSearched",
  "WebFetched",
  "WebSettingsChanged",
  "HobWebLimitsChanged",
]);
type WebEvent = Extract<
  HobbotsEvent,
  { readonly _tag: "WebSearched" | "WebFetched" | "WebSettingsChanged" | "HobWebLimitsChanged" }
>;
const isWebEvent = (event: HobbotsEvent): event is WebEvent => WEB_EVENTS.has(event._tag);

type ChapterEvent = Extract<
  HobbotsEvent,
  { readonly _tag: "ChapterStarted" | "ChapterSplit" | "ChapterMerged" | "ChapterSummarized" }
>;
const CHAPTER_EVENTS: ReadonlySet<string> = new Set([
  "ChapterStarted",
  "ChapterSplit",
  "ChapterMerged",
  "ChapterSummarized",
]);
const isChapterEvent = (event: HobbotsEvent): event is ChapterEvent => CHAPTER_EVENTS.has(event._tag);

/** Reads again what an event changed when it patches nothing itself; whether it was such an event. */
const readAgain = (
  queryClient: QueryClient,
  event: HobbotsEvent,
): event is
  | WebEvent
  | ChapterEvent
  | Extract<HobbotsEvent, { readonly _tag: "SkillUsed" }>
  | Parameters<typeof applyRecordEvent>[1]
  | Parameters<typeof applySuggestionEvent>[1]
  | Parameters<typeof applyPinEvent>[1]
  | ClaimEvent
  | Extract<HobbotsEvent, { readonly _tag: "ThreadMemberChanged" }> => {
  // A split or a merge moves messages between chapters (ADR 037): the thread's transcript is read
  // again, and which threads are unread, since a read thread stays read. A started or summarized
  // chapter moves none.
  if (isChapterEvent(event)) {
    void applyChapterEvent(queryClient, event);
    if (event._tag === "ChapterSplit" || event._tag === "ChapterMerged") {
      void queryClient.invalidateQueries({ queryKey: queryKeys.messages(event.threadId), exact: true });
      void unreadChanged(queryClient);
    }
    return true;
  }
  // A person read a thread, or a member left or came back (ADR 039): which threads are unread for
  // you is read again, from your own markers. A hob reads nothing.
  if (event._tag === "ThreadMemberChanged") {
    if (event.member.actor.kind === "user") {
      void unreadChanged(queryClient);
    }
    return true;
  }
  // A search or a page recorded, or Settings › Web or a hob's limits changed (ADR 036).
  if (isWebEvent(event)) {
    void webChanged(queryClient);
    return true;
  }
  // The camp sheet's records, the suggestion card and pins (ADR 037, #1387) read their list again.
  if (isRecordEvent(event)) {
    void applyRecordEvent(queryClient, event);
    return true;
  }
  if (isSuggestionEvent(event)) {
    void applySuggestionEvent(queryClient, event);
    return true;
  }
  if (isPinEvent(event)) {
    void applyPinEvent(queryClient, event);
    return true;
  }
  // A claim made, contested, cleared or released changes the Heads-ups (#1390).
  if (isClaimEvent(event)) {
    void applyClaimEvent(queryClient);
    return true;
  }
  // A reply's use line comes with the reply; the counts a skill's Activity and a hob's Used lately show are read again.
  if (event._tag === "SkillUsed") {
    void refreshSkillUses(queryClient);
    return true;
  }
  return false;
};

type ThreadEvent = Extract<
  HobbotsEvent,
  { readonly _tag: "ThreadUpserted" | "CampMade" | "ChatStartedFresh" | "ChapterMoved" }
>;
const THREAD_EVENTS: ReadonlySet<HobbotsEvent["_tag"]> = new Set([
  "ThreadUpserted",
  "CampMade",
  "ChatStartedFresh",
  "ChapterMoved",
]);
const isThreadEvent = (event: HobbotsEvent): event is ThreadEvent => THREAD_EVENTS.has(event._tag);

/** A thread changed, a camp was made, a chat was started fresh or a chapter moved into a camp (ADR 037). */
const applyThreadEvent = (queryClient: QueryClient, event: ThreadEvent) => {
  // The quests a fresh chat or a moved chapter took along take their clashes with them (#1390).
  if (event._tag === "ChatStartedFresh") {
    chatStartedFresh(queryClient, event);
    void applyClaimEvent(queryClient);
    return;
  }
  if (event._tag === "ChapterMoved") {
    void chapterMoved(queryClient, event);
    void applyClaimEvent(queryClient);
    // A thread you had read stays read, and a camp just made starts read (ADR 039).
    void unreadChanged(queryClient);
    return;
  }
  // A thread archived or restored elsewhere moves between the hob's two lists.
  recordThread(queryClient, event.thread);
  placeThread(queryClient, event.thread);
};

/**
 * Applies an event to the Query cache and records what it changed in the sync generation's overlay.
 * Lists are only patched once loaded; creating a partial list here would hide the rest of it.
 */
export const applyEvent = (queryClient: QueryClient, event: HobbotsEvent) => {
  applyQuestWork(queryClient, event);
  applyHistory(queryClient, event);
  applyHobChanges(queryClient, event);
  // An open quest's Workbench follows its tree's records on the tree's own stream (ADR 027).
  // A running command's output is transient and kept as it comes, whichever stream brings it.
  if (isWorkbenchEvent(event)) {
    if (event._tag === "CommandOutput") applyCommandOutput(queryClient, event);
    return;
  }
  if (isUnapplied(event)) return;
  if (readAgain(queryClient, event)) return;
  if (applyReviewEvent(queryClient, event)) return;
  if (isMemoryEvent(event)) {
    applyMemoryEvent(queryClient, event);
    return;
  }
  if (isThreadEvent(event)) {
    applyThreadEvent(queryClient, event);
    return;
  }
  switch (event._tag) {
    case "AgentUpserted":
      applyAgent(queryClient, event.agent);
      return;
    case "MessageUpserted":
      recordMessage(queryClient, event.message);
      // Before the transcript takes the new copy, so the copy it held tells a reply that just ended.
      showUnread(queryClient, event.message);
      queryClient.setQueryData<ReadonlyArray<Message>>(queryKeys.messages(event.message.threadId), (old) =>
        old ? upsertNewer(old, event.message, upsertMessage) : old,
      );
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
    // How a Quest is going, as the hub folded it (ADR 037).
    case "QuestSummaryChanged":
      questSummaryChanged(queryClient, event.summary);
      return;
    default:
      applyWorkEvent(queryClient, event);
      return;
  }
};

type MemoryEvent = Extract<
  HobbotsEvent,
  { readonly _tag: "MemorySaveRecorded" | "MemorySaveChanged" | "MemoryShareRequested" | "MemoryShareChanged" }
>;
const MEMORY_EVENTS = new Set<HobbotsEvent["_tag"]>([
  "MemorySaveRecorded",
  "MemorySaveChanged",
  "MemoryShareRequested",
  "MemoryShareChanged",
]);
const isMemoryEvent = (event: HobbotsEvent): event is MemoryEvent => MEMORY_EVENTS.has(event._tag);

type ProposalEvent = Extract<
  HobbotsEvent,
  { readonly _tag: "SkillProposalRequested" | "SkillProposalChanged" | "SkillFeedbackLeft" }
>;
const PROPOSAL_EVENTS = new Set<HobbotsEvent["_tag"]>([
  "SkillProposalRequested",
  "SkillProposalChanged",
  "SkillFeedbackLeft",
]);
const isProposalEvent = (event: HobbotsEvent): event is ProposalEvent => PROPOSAL_EVENTS.has(event._tag);

/**
 * A proposal's event, or a change to the skills library: the Inbox reads the proposals again, so a
 * review waiting there shows the library as Add would find it, and a hob's next turn may get other
 * skills, which the composer's `/` list shows (ADR 029). A note on a skill shows in its Activity.
 * Whether the event was one of these.
 */
type HobProposalEvent = Extract<HobbotsEvent, { readonly _tag: "HobProposalRequested" | "HobProposalChanged" }>;

/** What waits for your review: a hob proposal (ADR 034), or a skill's proposal, update or change. */
const applyReviewEvent = (
  queryClient: QueryClient,
  event: HobbotsEvent,
): event is HobProposalEvent | ProposalEvent | SkillLibraryChange | SkillUpdateEvent => {
  // A hob proposal was made or moved: the Inbox and the reply step that shows it read it again.
  if (event._tag === "HobProposalRequested" || event._tag === "HobProposalChanged") {
    void hobProposalsChanged(queryClient);
    return true;
  }
  return applySkillEvent(queryClient, event);
};

const applySkillEvent = (
  queryClient: QueryClient,
  event: HobbotsEvent,
): event is ProposalEvent | SkillLibraryChange | SkillUpdateEvent => {
  if (isSkillUpdateEvent(event)) {
    void refreshSkillUpdates(queryClient);
    return true;
  }
  // A skill changed here, on another device or in `~/.agents/skills`: the Skills page reads it again,
  // and what a hob's next turn gets may have changed, which the composer's `/` list shows (ADR 029).
  if (isSkillLibraryChange(event)) {
    void refreshSkills(queryClient);
    void hobSkillsChanged(queryClient);
    if (REVIEWED_LIBRARY.has(event._tag)) void skillProposalsChanged(queryClient);
    return true;
  }
  if (!isProposalEvent(event)) return false;
  if (event._tag === "SkillFeedbackLeft") void refreshSkillFeedback(queryClient);
  else void skillProposalsChanged(queryClient);
  return true;
};

/** A hob's save or share, as memory's lists show it (ADR 028). */
const applyMemoryEvent = (queryClient: QueryClient, event: MemoryEvent) => {
  // A save shows under the reply it was made from; a share, or a share that moved, has the Inbox,
  // To review and memory read it again.
  if (event._tag === "MemorySaveRecorded" || event._tag === "MemorySaveChanged") {
    void applyMemorySave(queryClient, event.save);
  } else {
    void memorySharesChanged(queryClient);
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
            | "ApprovalMoved"
            | "GrantCreated"
            | "GrantRevoked"
            | "BackpackItemRecorded"
            | "BackpackItemChanged"
            | "PairingRequested"
            | "PairingChanged"
            | "DeviceRevoked"
            | "HubQuestionRaised"
            | "HubQuestionAnswered"
            | "HubQuestionWithdrawn";
        }
      >,
) => {
  switch (event._tag) {
    case "ApprovalRequested":
    case "ApprovalResolved":
      storeApproval(queryClient, event.approval);
      return;
    case "ApprovalMoved":
      moveApproval(queryClient, event.fromThreadId, event.approval);
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
      void failedTaskChanged(queryClient, event.task);
      return;
    // The rest change Tasks and Quests (ADR 018). A question that reaches you, or leaves you, also
    // changes what waits in your Inbox. A question the hub itself asks has no Task (#976).
    default:
      if ("hubQuestion" in event) {
        void hubQuestionChanged(queryClient, event.hubQuestion);
        return;
      }
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
        // Status events are not replayed, so even a resumed stream reads the hub's status again.
        statusReady(queryClient);
        void refreshMemory(queryClient);
        void refreshMemorySaves(queryClient);
        // What changed while the stream was down is not replayed into the Skills page's reads.
        void refreshSkills(queryClient);
        // Nor what hobs searched and read.
        void webChanged(queryClient);
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
    source.addEventListener(STREAM_FRAME.status, (frame) => {
      try {
        applyStatusFrame(queryClient, frame.data);
      } catch (error) {
        console.warn("Ignoring malformed event", error);
      }
    });
    source.addEventListener(STREAM_FRAME.memory, (frame) => {
      try {
        void applyMemoryChanged(queryClient, decodeMemoryChanged(frame.data));
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
