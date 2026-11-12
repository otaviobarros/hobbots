import { Effect, Schema } from "effect";
import { CommandId, CommandRecord, FileChange, FileChangeId, FolderScan } from "./activity.ts";
import { Agent } from "./agent.ts";
import { ApprovalRequest } from "./approval.ts";
import { Artifact } from "./artifact.ts";
import { BackpackItem } from "./backpack.ts";
import { CampSuggestion } from "./camp-suggestion.ts";
import { CarriedOver } from "./carried-over.ts";
import { ChangeActor, YOU } from "./change-actor.ts";
import { Chapter } from "./chapter.ts";
import { Claim } from "./claim.ts";
import { Decision } from "./decision.ts";
import { Device, PairingRequest } from "./device.ts";
import { Grant } from "./grant.ts";
import { HobProposal } from "./hob-proposals.ts";
import { HubQuestion } from "./hub-question.ts";
import { AgentId, ChapterId, MessageId, ThreadId } from "./ids.ts";
import { MemoryShare } from "./memory-shares.ts";
import { MemorySave } from "./memory-tools.ts";
import { Message, ReplyStep } from "./message.ts";
import { HobPresence, ThreadRunStatus } from "./presence.ts";
import {
  ArtifactRef,
  Checkpoint,
  Delegation,
  HandOff,
  Milestone,
  Quest,
  Question,
  RefusedCall,
  TaskNote,
  TaskWait,
} from "./quest.ts";
import { SkillFeedback, SkillProposal } from "./skill-proposals.ts";
import { SkillUpdate } from "./skill-updates.ts";
import {
  Skill,
  SkillAssignment,
  SkillId,
  SkillOptOut,
  SkillRevision,
  SkillRevisionHash,
  SkillSource,
  SkillUse,
} from "./skills.ts";
import { Attempt, AttemptId, Task, TaskId } from "./task.ts";
import { Thread } from "./thread.ts";
import { HobWebLimits, WebFetchRecord, WebSearchRecord, WebSettings } from "./web-usage.ts";

/**
 * A hob was created, changed, paused, woken, retired or brought back, by `actor` (ADR 034). Events
 * journaled before the actor was recorded read as yours, since only you could change a hob then.
 */
const AgentUpserted = Schema.TaggedStruct("AgentUpserted", {
  agent: Agent,
  actor: ChangeActor.pipe(Schema.withDecodingDefaultKey(Effect.succeed(YOU))),
});
const ThreadUpserted = Schema.TaggedStruct("ThreadUpserted", { thread: Thread });
/** You made a camp for a hob, with its title, goal and whether it is private (ADR 037). */
const CampMade = Schema.TaggedStruct("CampMade", { thread: Thread });
/**
 * You started a hob's chat fresh (ADR 037): `superseded` is the chat as it was left, `chat` the new
 * one, and `carried` what moved from one to the other. The backpack items that moved are journaled
 * after it, each as its own `BackpackItemChanged`.
 */
const ChatStartedFresh = Schema.TaggedStruct("ChatStartedFresh", {
  superseded: Thread,
  chat: Thread,
  carried: Schema.Array(CarriedOver),
});
const MessageUpserted = Schema.TaggedStruct("MessageUpserted", { message: Message });
/** A user message joined its thread's queue because a reply was running. */
const MessageQueued = Schema.TaggedStruct("MessageQueued", { message: Message });
/** A queued message left the queue: its turn started (after its MessageUpserted), or the user removed it. */
const MessageDequeued = Schema.TaggedStruct("MessageDequeued", {
  threadId: ThreadId,
  messageId: MessageId,
  reason: Schema.Literals(["started", "removed"]),
});
/**
 * A thread started a chapter (ADR 037): its first, as the thread was made, or the next one, which
 * `ended` (the live chapter until then) made way for.
 */
const ChapterStarted = Schema.TaggedStruct("ChapterStarted", {
  threadId: ThreadId,
  chapter: Chapter,
  ended: Schema.NullOr(Chapter),
});
/**
 * Chapter `from` was cut at message `messageId`: its messages from there on now belong to the new
 * chapter `chapter`, right after it. `chapters` is the thread's chapters afterwards, in order.
 */
const ChapterSplit = Schema.TaggedStruct("ChapterSplit", {
  threadId: ThreadId,
  from: ChapterId,
  chapter: ChapterId,
  messageId: MessageId,
  chapters: Schema.Array(Chapter),
});
/**
 * Chapter `absorbed` merged into `into`, the chapter before it, which now holds its messages; it is
 * gone. `chapters` is the thread's chapters afterwards, in order.
 */
const ChapterMerged = Schema.TaggedStruct("ChapterMerged", {
  threadId: ThreadId,
  into: ChapterId,
  absorbed: ChapterId,
  chapters: Schema.Array(Chapter),
});
/**
 * The chapter summary projector wrote a resting chapter's one-line summary (#1380). A private
 * camp's stays in that camp: memory capture takes nothing from it.
 */
const ChapterSummarized = Schema.TaggedStruct("ChapterSummarized", { threadId: ThreadId, chapter: Chapter });
/**
 * A chapter of thread `threadId` moved into `camp` (ADR 037, #1385), with its messages, decisions,
 * artifacts and the quests started in it, whose open questions go with them. The thread keeps
 * `stub`, moved, and the camp holds them in `chapter`, its live chapter. `thread` and `camp` are the
 * two threads afterwards, and `chapters` and `campChapters` their chapters, in order. The backpack
 * items that moved are journaled after it, each as its own `BackpackItemChanged`.
 */
const ChapterMoved = Schema.TaggedStruct("ChapterMoved", {
  threadId: ThreadId,
  thread: Thread,
  camp: Thread,
  stub: Chapter,
  chapter: Chapter,
  chapters: Schema.Array(Chapter),
  campChapters: Schema.Array(Chapter),
});
/** The hub suggested making a chat's chapter a camp (ADR 037, #1385): a threshold rule or the hub's brain raised it. */
const CampSuggested = Schema.TaggedStruct("CampSuggested", { threadId: ThreadId, suggestion: CampSuggestion });
/** You kept a suggested chapter in the chat; it is never suggested again. */
const CampSuggestionKept = Schema.TaggedStruct("CampSuggestionKept", {
  threadId: ThreadId,
  suggestion: CampSuggestion,
});
/** A suggested chapter moved into a camp, journaled after its `ChapterMoved`. */
const CampSuggestionAccepted = Schema.TaggedStruct("CampSuggestionAccepted", {
  threadId: ThreadId,
  suggestion: CampSuggestion,
});
/** A suggestion no longer applies: its chapter was merged away, or its chat closed. */
const CampSuggestionExpired = Schema.TaggedStruct("CampSuggestionExpired", {
  threadId: ThreadId,
  suggestion: CampSuggestion,
});
/** The user asked to stop a reply; it shows as stopping until the runtime confirms. */
const TurnStopRequested = Schema.TaggedStruct("TurnStopRequested", { threadId: ThreadId, messageId: MessageId });
/** The runtime confirmed the stopped turn ended; the reply is now stopped. */
const TurnStopped = Schema.TaggedStruct("TurnStopped", { threadId: ThreadId, messageId: MessageId });
/** A tool call the policy answered Ask for paused its turn until the user decides (PE-003). */
const ApprovalRequested = Schema.TaggedStruct("ApprovalRequested", { approval: ApprovalRequest });
/** A pending approval was approved, denied or expired; `approval.state` says which. */
const ApprovalResolved = Schema.TaggedStruct("ApprovalResolved", { approval: ApprovalRequest });
/** A decision with a lifetime saved a standing grant for its hob (ADR 015). */
const GrantCreated = Schema.TaggedStruct("GrantCreated", { grant: Grant });
/** A grant stopped applying: the user removed it, or a change took away the authority it relied on. */
const GrantRevoked = Schema.TaggedStruct("GrantRevoked", { grant: Grant });
/** A device without a token asked to pair (ADR 021). The request carries its code, never its secret. */
const PairingRequested = Schema.TaggedStruct("PairingRequested", { request: PairingRequest });
/** A pairing request was allowed, denied, put off with Decide later, or claimed by its device. */
const PairingChanged = Schema.TaggedStruct("PairingChanged", { request: PairingRequest });
/** The user revoked a device: its requests are refused from now on (ADR 021). Carries no token. */
const DeviceRevoked = Schema.TaggedStruct("DeviceRevoked", { device: Device });
/** A Task, a step or a delegated Task was created, with its Delegation and planned Milestones (ADR 018). */
const TaskCreated = Schema.TaggedStruct("TaskCreated", {
  task: Task,
  delegation: Schema.NullOr(Delegation),
  milestones: Schema.Array(Milestone),
});
/**
 * What you did to a Task from the Quest tab, when a change came from it (ADR 018): a retry queues
 * it again for its owner; a reassignment gives it to another hob, `from` the one that had it. Each
 * carries the Task's Delegation as it now is, so its owner's backpack gets the work again.
 */
export const TaskControl = Schema.Union([
  Schema.TaggedStruct("Retried", { delegation: Schema.NullOr(Delegation) }),
  Schema.TaggedStruct("Reassigned", { from: AgentId, delegation: Delegation }),
]);
export type TaskControl = typeof TaskControl.Type;

/**
 * A Task's state, owner or current Attempt changed: a start, a retry, a reassignment, a wait, a
 * cancel, or its Attempt moving on. `attempt` is the current one when it changed; `quest` the
 * Task's Quest when it ended or reopened with it; `wait` the wait its owner started or replaced, so
 * who it waits on shows live; `control` what you did, when the change was yours; `reply` the final
 * reply of the turn that ended `attempt`, for a Task below the top one, redacted as its runner gave
 * it, so memory keeps what the hob said outside any chat (ADR 028); capture cuts it on its way out.
 */
const TaskStateChanged = Schema.TaggedStruct("TaskStateChanged", {
  task: Task,
  attempt: Schema.NullOr(Attempt),
  quest: Schema.NullOr(Quest),
  wait: Schema.NullOr(TaskWait).pipe(Schema.withDecodingDefaultKey(Effect.succeed(null))),
  control: Schema.optionalKey(TaskControl),
  reply: Schema.optionalKey(Schema.String),
});
/** A Task gained its Quest record: its owner brought in another hob. */
const QuestStarted = Schema.TaggedStruct("QuestStarted", { quest: Quest });
/** A Checkpoint was recorded; `milestone` is the one it reached, now with `reachedAt` and `reachedBy`. */
const CheckpointRecorded = Schema.TaggedStruct("CheckpointRecorded", {
  checkpoint: Checkpoint,
  milestone: Schema.NullOr(Milestone),
});
const QuestionAsked = Schema.TaggedStruct("QuestionAsked", { question: Question });
const QuestionAnswered = Schema.TaggedStruct("QuestionAnswered", { question: Question });
/** A lead passed a question up: to the next lead, or to the user when `recipientId` is null. */
const QuestionEscalated = Schema.TaggedStruct("QuestionEscalated", { question: Question });
/** A question's Task ended as cancelled or failed before anyone answered it, so it was withdrawn. */
const QuestionWithdrawn = Schema.TaggedStruct("QuestionWithdrawn", { question: Question });
/** The hub put a question to you itself (#976): it goes straight to you, never to a lead. */
const HubQuestionRaised = Schema.TaggedStruct("HubQuestionRaised", { hubQuestion: HubQuestion });
/** You answered a question from the hub; the part of the hub that raised it applies the answer. */
const HubQuestionAnswered = Schema.TaggedStruct("HubQuestionAnswered", { hubQuestion: HubQuestion });
/** The hub no longer needs the answer to its question, so it was withdrawn. */
const HubQuestionWithdrawn = Schema.TaggedStruct("HubQuestionWithdrawn", { hubQuestion: HubQuestion });
/** You left a note on a Task; it goes to the Task's nearest lead (ADR 018). */
const NoteLeft = Schema.TaggedStruct("NoteLeft", { note: TaskNote });
/** A turn of a note's recipient picked it up: the backpack put it into that turn, which its runtime accepted (#900, ADR 019). */
const NotePickedUp = Schema.TaggedStruct("NotePickedUp", { note: TaskNote });
/** A lead gave one Task's artifact to another Task. */
const HandedOff = Schema.TaggedStruct("HandedOff", { handOff: HandOff, artifact: ArtifactRef });
/**
 * A hob claimed a number, a path or a branch for its Task (ADR 037), with the open claims of other
 * Tasks it clashes with, which the same change contested. Each lead involved hears of a clash
 * through its backpack.
 */
const ClaimMade = Schema.TaggedStruct("ClaimMade", { claim: Claim, clashes: Schema.Array(Claim) });
/** Another Task's claim on the same path or branch made this claim contested. */
const ClaimContested = Schema.TaggedStruct("ClaimContested", { claim: Claim });
/** The last claim this one clashed with was released, so it is held alone again. */
const ClaimCleared = Schema.TaggedStruct("ClaimCleared", { claim: Claim });
/** The claim's Task ended, so the claim was released; a released number is never handed out again. */
const ClaimReleased = Schema.TaggedStruct("ClaimReleased", { claim: Claim });
/** A decision was recorded in a chat or camp, by a hob's `record_decision` or by you (ADR 037). */
const DecisionRecorded = Schema.TaggedStruct("DecisionRecorded", { decision: Decision });
/**
 * A decision was crossed out: kept, no longer holding, and replaced by `supersededBy` when another
 * decision changed it, which is journaled just before.
 */
const DecisionSuperseded = Schema.TaggedStruct("DecisionSuperseded", { decision: Decision });
/**
 * A record made or changed an artifact (ADR 037): the registry's row at its latest version, written
 * in the transaction that journaled the record, once per record.
 */
const ArtifactRegistered = Schema.TaggedStruct("ArtifactRegistered", { artifact: Artifact });
/** A Task passed the completion gate, with its result and the artifacts it made. */
const TaskCompleted = Schema.TaggedStruct("TaskCompleted", { task: Task, artifacts: Schema.Array(ArtifactRef) });
/** The Task that holds a Quest passed the completion gate. */
const QuestCompleted = Schema.TaggedStruct("QuestCompleted", { quest: Quest });
/** A backpack item was committed with the change that caused it (ADR 019). */
const BackpackItemRecorded = Schema.TaggedStruct("BackpackItemRecorded", { item: BackpackItem });
/** A backpack item was claimed, delivered, acknowledged, processed, put back, resolved or failed. */
const BackpackItemChanged = Schema.TaggedStruct("BackpackItemChanged", { item: BackpackItem });
/** A command an Attempt ran started, or ended with its output (ADR 023). */
const CommandRecorded = Schema.TaggedStruct("CommandRecorded", { command: CommandRecord });
/**
 * An Attempt's file changes in one folder, as a scan found them (ADR 023): `changes` were added or
 * replaced, and the changes in `removed` no longer differ from the turn's start, as a file put back.
 */
const FileChangesRecorded = Schema.TaggedStruct("FileChangesRecorded", {
  attemptId: AttemptId,
  taskId: TaskId,
  folder: Schema.String,
  changes: Schema.Array(FileChange),
  removed: Schema.Array(FileChangeId),
});
/**
 * An Attempt's session read the web, or read another page, so its read-the-web mark changed (ADR
 * 036): the Attempt as it is now, for a Workbench already open on it.
 */
const AttemptReadWeb = Schema.TaggedStruct("AttemptReadWeb", { taskId: TaskId, attempt: Attempt });
/** The steps an Attempt's turn outside any chat has so far, all of them, as they change (#892). */
const AttemptStepsRecorded = Schema.TaggedStruct("AttemptStepsRecorded", {
  attemptId: AttemptId,
  taskId: TaskId,
  steps: Schema.Array(ReplyStep),
});
/** The hub refused a Task tool call, or refused a retried one again (ADR 018). */
const ToolCallRefused = Schema.TaggedStruct("ToolCallRefused", { refusal: RefusedCall });
/**
 * A hob's `memory_save` was recorded before it was sent (ADR 028): the journal is the outbox, so the
 * capture worker sends a save memory did not take at once.
 */
const MemorySaveRecorded = Schema.TaggedStruct("MemorySaveRecorded", { save: MemorySave });
/** A recorded save was sent: memory took it, kept it for later, or refused it. */
const MemorySaveChanged = Schema.TaggedStruct("MemorySaveChanged", { save: MemorySave });
/**
 * A hob asked to share a page with a project or every hob (ADR 028, Sharing), recorded before
 * anything is written: it waits for your review, or the preset lets it through.
 */
const MemoryShareRequested = Schema.TaggedStruct("MemoryShareRequested", { share: MemoryShare });
/** A share moved: it went through, you shared it or kept it private, or you took it back. */
const MemoryShareChanged = Schema.TaggedStruct("MemoryShareChanged", { share: MemoryShare });
/**
 * A revision joined the library (ADR 029): a new skill's first, or a later one of a skill it has, with
 * the source it was read from when that source is new. `skill` is the skill as it now is.
 */
const SkillRevisionAdded = Schema.TaggedStruct("SkillRevisionAdded", {
  skill: Skill,
  revision: SkillRevision,
  source: Schema.NullOr(SkillSource),
});
/** A skill was assigned to a scope, pinned to a revision, or an assignment's Only when asked changed. */
const SkillAssigned = Schema.TaggedStruct("SkillAssigned", { assignment: SkillAssignment });
/** A skill was taken off a scope. */
const SkillUnassigned = Schema.TaggedStruct("SkillUnassigned", { assignment: SkillAssignment });
/** An assignment's pin moved from `from` to its `pin`: a rollout, or a rollback to an older revision. */
const SkillRolledOut = Schema.TaggedStruct("SkillRolledOut", { assignment: SkillAssignment, from: SkillRevisionHash });
/** An assignment was held on its revision (Keep on r4), or let follow rollouts again; `held` says which. */
const SkillHeld = Schema.TaggedStruct("SkillHeld", { assignment: SkillAssignment });
/** A hob turned an Everyone or Project skill off for itself, or on again. */
const SkillOptOutChanged = Schema.TaggedStruct("SkillOptOutChanged", { optOut: SkillOptOut, optedOut: Schema.Boolean });
/** A skill left the library, with its assignments gone before it. Its revisions' files stay for backups. */
const SkillRemoved = Schema.TaggedStruct("SkillRemoved", { skill: Skill });
/** A hob proposed a new skill or a revision (ADR 029, Proactive hobs), recorded before you see it. It waits for you. */
const SkillProposalRequested = Schema.TaggedStruct("SkillProposalRequested", { proposal: SkillProposal });
/** A proposal moved: you accepted it and the hub is writing it, it was added, or you said Not now. */
const SkillProposalChanged = Schema.TaggedStruct("SkillProposalChanged", { proposal: SkillProposal });
/**
 * A Summoning Charm call that asks became a proposal (ADR 034), recorded on the manager's call before
 * you see it. It waits for you in the Inbox and on the call's step.
 */
const HobProposalRequested = Schema.TaggedStruct("HobProposalRequested", { proposal: HobProposal });
/** You decided a row of a proposal, edited one, pressed "Always allow" on it, or it settled. */
const HobProposalChanged = Schema.TaggedStruct("HobProposalChanged", { proposal: HobProposal });
/** A hob noted that a skill is wrong, outdated or unclear. */
const SkillFeedbackLeft = Schema.TaggedStruct("SkillFeedbackLeft", { feedback: SkillFeedback });
/**
 * A check found an upstream revision of a skill imported from Git (ADR 029, Updates from a source).
 * It waits in Updates, with its review, until you accept it or say Not now.
 */
const SkillUpdateFound = Schema.TaggedStruct("SkillUpdateFound", { update: SkillUpdate });
/** You said Not now to an update: it leaves Updates until the source changes again. */
const SkillUpdateDismissed = Schema.TaggedStruct("SkillUpdateDismissed", { update: SkillUpdate });
/**
 * An update left Updates: it was accepted, by you or by Update automatically, or the source no longer
 * holds it, or the library has its content already.
 */
const SkillUpdateCleared = Schema.TaggedStruct("SkillUpdateCleared", {
  skillId: SkillId,
  hash: SkillRevisionHash,
});
/** You turned Update automatically on or off for a skill from Git. */
const SkillAutoUpdateChanged = Schema.TaggedStruct("SkillAutoUpdateChanged", { skillId: SkillId, on: Schema.Boolean });
/** A search a runtime ran was recorded (ADR 036, Usage and limits). */
const WebSearched = Schema.TaggedStruct("WebSearched", { search: WebSearchRecord });
/** A page `web_fetch` read was recorded (ADR 036, Usage and limits). */
const WebFetched = Schema.TaggedStruct("WebFetched", { fetch: WebFetchRecord });
/** Settings › Web changed: the limits every hob has, or the blocked sites. */
const WebSettingsChanged = Schema.TaggedStruct("WebSettingsChanged", { settings: WebSettings });
/** A hob's own web limits changed. */
const HobWebLimitsChanged = Schema.TaggedStruct("HobWebLimitsChanged", { agentId: AgentId, limits: HobWebLimits });
/** A hob used a skill in a turn (ADR 029, The use line): the revision the turn mounted, or an organization's skill. */
const SkillUsed = Schema.TaggedStruct("SkillUsed", { use: SkillUse });
/** One of the hob's folders was scanned at the start or end of a turn, or stopped being tracked. */
const FolderScanned = Schema.TaggedStruct("FolderScanned", { scan: FolderScan });
/**
 * A piece of what a running command printed, redacted, from a runtime that reports output as it
 * comes (ADR 023). Transient: the whole output reaches durable state when the command ends.
 * `offset` is where the piece starts in what the command printed so far, in UTF-16 code units.
 */
export const CommandOutput = Schema.TaggedStruct("CommandOutput", {
  attemptId: AttemptId,
  taskId: TaskId,
  commandId: CommandId,
  offset: Schema.Int,
  delta: Schema.String,
});
export type CommandOutput = typeof CommandOutput.Type;

/**
 * A piece of a streaming reply. Transient: its text reaches durable state through the message (ADR 013).
 * `offset` is where the piece starts in the message's text, in UTF-16 code units, so a client
 * applies it idempotently: it skips text it already has.
 */
export const MessageDelta = Schema.TaggedStruct("MessageDelta", {
  threadId: ThreadId,
  messageId: MessageId,
  offset: Schema.Int,
  delta: Schema.String,
});

/**
 * A turn joined the hub's running turns, so `GET /api/activity` reports its hob working. Transient:
 * the running turns live in the hub's process, so a replay could name a turn a restart already ended.
 */
export const TurnStarted = Schema.TaggedStruct("TurnStarted", { threadId: ThreadId, agentId: AgentId });
/**
 * A turn left the hub's running turns, after its runtime exited, so `GET /api/activity` no longer
 * reports it. Transient, like `TurnStarted`.
 */
export const TurnEnded = Schema.TaggedStruct("TurnEnded", { threadId: ThreadId, agentId: AgentId });
export type TurnStarted = typeof TurnStarted.Type;
export type TurnEnded = typeof TurnEnded.Type;

/**
 * A thread's run changed (ADR 037): published once for every transition of its `ThreadRun`, after
 * the change, with the run as it now is. Transient: runs live in the hub's process and a restart
 * leaves every one idle, so on every `Ready` a client drops the status it held and reads
 * `GET /api/status` again instead.
 */
export const ThreadRunChanged = Schema.TaggedStruct("ThreadRunChanged", { run: ThreadRunStatus });
export type ThreadRunChanged = typeof ThreadRunChanged.Type;

/**
 * A hob's presence changed (ADR 037): its lifecycle, what waits on you, or what its threads' replies
 * are doing. Published only when the presence differs from the last one published. Transient, like
 * `ThreadRunChanged`.
 */
export const HobPresenceChanged = Schema.TaggedStruct("HobPresenceChanged", { presence: HobPresence });
export type HobPresenceChanged = typeof HobPresenceChanged.Type;

/**
 * A hob no longer has a presence, as once it retires, at `revision` of the presences. Transient,
 * like `HobPresenceChanged`.
 */
export const HobPresenceRemoved = Schema.TaggedStruct("HobPresenceRemoved", { agentId: AgentId, revision: Schema.Int });
export type HobPresenceRemoved = typeof HobPresenceRemoved.Type;

/** A transient event: delivered live, never journaled. */
export type TransientEvent =
  | MessageDelta
  | TurnStarted
  | TurnEnded
  | CommandOutput
  | ThreadRunChanged
  | HobPresenceChanged
  | HobPresenceRemoved;

/** State events: each is written to the event journal in the transaction that makes its change (ADR 013). */
export const JournaledEvent = Schema.Union([
  AgentUpserted,
  ThreadUpserted,
  CampMade,
  ChatStartedFresh,
  MessageUpserted,
  MessageQueued,
  MessageDequeued,
  ChapterStarted,
  ChapterSplit,
  ChapterMerged,
  ChapterSummarized,
  ChapterMoved,
  CampSuggested,
  CampSuggestionKept,
  CampSuggestionAccepted,
  CampSuggestionExpired,
  TurnStopRequested,
  TurnStopped,
  ApprovalRequested,
  ApprovalResolved,
  GrantCreated,
  GrantRevoked,
  TaskCreated,
  TaskStateChanged,
  QuestStarted,
  CheckpointRecorded,
  QuestionAsked,
  QuestionAnswered,
  QuestionEscalated,
  QuestionWithdrawn,
  HubQuestionRaised,
  HubQuestionAnswered,
  HubQuestionWithdrawn,
  NoteLeft,
  NotePickedUp,
  HandedOff,
  TaskCompleted,
  QuestCompleted,
  ClaimMade,
  ClaimContested,
  ClaimCleared,
  ClaimReleased,
  DecisionRecorded,
  DecisionSuperseded,
  ArtifactRegistered,
  BackpackItemRecorded,
  BackpackItemChanged,
  PairingRequested,
  PairingChanged,
  DeviceRevoked,
  CommandRecorded,
  FileChangesRecorded,
  FolderScanned,
  ToolCallRefused,
  AttemptStepsRecorded,
  AttemptReadWeb,
  MemorySaveRecorded,
  MemorySaveChanged,
  MemoryShareRequested,
  MemoryShareChanged,
  SkillRevisionAdded,
  SkillAssigned,
  SkillUnassigned,
  SkillRolledOut,
  SkillHeld,
  SkillOptOutChanged,
  SkillRemoved,
  SkillProposalRequested,
  SkillProposalChanged,
  HobProposalRequested,
  HobProposalChanged,
  SkillFeedbackLeft,
  SkillUsed,
  SkillUpdateFound,
  SkillUpdateDismissed,
  SkillUpdateCleared,
  SkillAutoUpdateChanged,
  WebSearched,
  WebFetched,
  WebSettingsChanged,
  HobWebLimitsChanged,
]);
export type JournaledEvent = typeof JournaledEvent.Type;

/** Events pushed to clients over SSE after the matching state change is committed. */
export const HobbotsEvent = Schema.Union([
  ...JournaledEvent.members,
  MessageDelta,
  TurnStarted,
  TurnEnded,
  CommandOutput,
  ThreadRunChanged,
  HobPresenceChanged,
  HobPresenceRemoved,
]);
export type HobbotsEvent = typeof HobbotsEvent.Type;
export type MessageDelta = typeof MessageDelta.Type;

/** Each journaled event type's payload version, from 1; an incompatible payload change bumps it (ADR 013). */
export const EVENT_SCHEMA_VERSIONS: Record<JournaledEvent["_tag"], number> = {
  // A hob's GitHub overrides moved to its Charm overrides under their Charm ids, read from the old names, compatibly.
  // Its `actor`, and the hob's `summonedBy`, `summonedFor` and `summonedUnattended`, were added with defaults, compatibly.
  AgentUpserted: 1,
  // 2: a thread carries its `sessions` and its own `brain`. 3: its `archivedAt`. Its `pinnedAt` was
  // added with a default, compatibly. 4: its `kind`, `goal`, `private`, `origin` and `state` (ADR 037).
  // 5: each session's `chapterId`, and the thread's `liveChapterId` (ADR 037, migration 0099).
  ThreadUpserted: 5,
  // 2: its threads' sessions' `chapterId` and `liveChapterId`, as `ThreadUpserted` 5 (migration 0099).
  CampMade: 2,
  ChatStartedFresh: 2,
  // 2: a reply can be `limited`, with `resetsAt`. 3: a reply carries its `steps`. 4: its `runtime` and `model`.
  // A reply's `usage`, and later its `promptId`, were added with defaults, compatibly. 5: its
  // `chapterId` (ADR 037, migration 0099). 6: its `actor` (ADR 037, migration 0101).
  MessageUpserted: 6,
  // 2: its message's `chapterId` (migration 0099). 3: its message's `actor` (migration 0101).
  MessageQueued: 3,
  MessageDequeued: 1,
  ChapterStarted: 1,
  ChapterSplit: 1,
  ChapterMerged: 1,
  ChapterSummarized: 1,
  ChapterMoved: 1,
  CampSuggested: 1,
  CampSuggestionKept: 1,
  CampSuggestionAccepted: 1,
  CampSuggestionExpired: 1,
  TurnStopRequested: 1,
  TurnStopped: 1,
  // A request's `grantable`, `rules`, `lifetime` and `expiresAt` were added with defaults, compatibly.
  // The GitHub operations and rules were renamed to Charm ids and `CharmSite`, read from the old ones, compatibly.
  ApprovalRequested: 1,
  ApprovalResolved: 1,
  // A grant's `taskId` replaced its unused `questId`, read as null when absent, compatibly.
  // The GitHub operations and rules were renamed to Charm ids and `CharmSite`, read from the old ones, compatibly.
  GrantCreated: 1,
  GrantRevoked: 1,
  // A Delegation's authority names the GitHub operations by their Charm ids, read from the old names, compatibly.
  TaskCreated: 1,
  // A change's `wait` was added with a default, and its optional `control` and `reply` later, compatibly.
  TaskStateChanged: 1,
  QuestStarted: 1,
  CheckpointRecorded: 1,
  QuestionAsked: 1,
  QuestionAnswered: 1,
  QuestionEscalated: 1,
  QuestionWithdrawn: 1,
  // 2: a hub question carries an `ask` and its choices' keys, not text and labels (#1045); migration
  // 0078 rewrote the stored entries.
  HubQuestionRaised: 2,
  HubQuestionAnswered: 2,
  HubQuestionWithdrawn: 2,
  // A note's `messageId`, `fromNoteId`, `pickedUpBy` and `pickedUpAt` were added with defaults, compatibly.
  NoteLeft: 1,
  NotePickedUp: 1,
  HandedOff: 1,
  TaskCompleted: 1,
  QuestCompleted: 1,
  ClaimMade: 1,
  ClaimContested: 1,
  ClaimCleared: 1,
  ClaimReleased: 1,
  DecisionRecorded: 1,
  DecisionSuperseded: 1,
  ArtifactRegistered: 1,
  // An item's `blockers` was added with a default, compatibly.
  BackpackItemRecorded: 1,
  BackpackItemChanged: 1,
  PairingRequested: 1,
  PairingChanged: 1,
  DeviceRevoked: 1,
  CommandRecorded: 1,
  FileChangesRecorded: 1,
  FolderScanned: 1,
  ToolCallRefused: 1,
  AttemptStepsRecorded: 1,
  AttemptReadWeb: 1,
  MemorySaveRecorded: 1,
  MemorySaveChanged: 1,
  MemoryShareRequested: 1,
  MemoryShareChanged: 1,
  SkillRevisionAdded: 1,
  SkillAssigned: 1,
  SkillUnassigned: 1,
  SkillRolledOut: 1,
  SkillHeld: 1,
  SkillOptOutChanged: 1,
  SkillRemoved: 1,
  SkillProposalRequested: 1,
  SkillProposalChanged: 1,
  HobProposalRequested: 1,
  HobProposalChanged: 1,
  SkillFeedbackLeft: 1,
  SkillUsed: 1,
  SkillUpdateFound: 1,
  SkillUpdateDismissed: 1,
  SkillUpdateCleared: 1,
  SkillAutoUpdateChanged: 1,
  WebSearched: 1,
  WebFetched: 1,
  WebSettingsChanged: 1,
  HobWebLimitsChanged: 1,
};

/** The IDs a journaled event applies to, for authorization filtering and tracing. */
export const EventCorrelation = Schema.Struct({
  agentId: Schema.NullOr(AgentId),
  threadId: Schema.NullOr(ThreadId),
  messageId: Schema.NullOr(MessageId),
});
export type EventCorrelation = typeof EventCorrelation.Type;

/** A committed journal entry: the envelope every journaled event is stored and sent in (ADR 013). */
export class EventEnvelope extends Schema.Class<EventEnvelope>("EventEnvelope")({
  id: Schema.String,
  /** Unique and gap-free per installation, in commit order. */
  sequence: Schema.Int,
  schemaVersion: Schema.Int,
  /** The payload's `_tag`. */
  type: Schema.String,
  /** When the change committed. Display only; order comes from `sequence`. */
  occurredAt: Schema.String,
  correlation: EventCorrelation,
  /** The event that caused this one, if any. */
  causationId: Schema.NullOr(Schema.String),
  payload: JournaledEvent,
}) {}

/** A committed write: what it stored, and the journal entries it appended, in sequence order. */
export interface Committed<A> {
  readonly value: A;
  readonly entries: ReadonlyArray<EventEnvelope>;
}

/** The events a saved message produces: always its upsert, then that it queued or any stop outcome it records. */
export const messageEvents = (message: Message): ReadonlyArray<JournaledEvent> => {
  const ids = { threadId: message.threadId, messageId: message.id };
  const upserted: JournaledEvent = { _tag: "MessageUpserted", message };
  switch (message.status) {
    case "queued":
      return [upserted, { _tag: "MessageQueued", message }];
    case "stopping":
      return [upserted, { _tag: "TurnStopRequested", ...ids }];
    case "stopped":
      return [upserted, { _tag: "TurnStopped", ...ids }];
    default:
      return [upserted];
  }
};

/**
 * The first frame of every event stream connection (ADR 013). `cursor` is where the connection
 * starts. `resumed` is false when the client's cursor was missing, from another journal epoch or past
 * retention: nothing was replayed, and the client refetches its queries as the snapshot.
 */
export const StreamReady = Schema.Struct({ cursor: Schema.String, resumed: Schema.Boolean });
export type StreamReady = typeof StreamReady.Type;

/**
 * The SSE event names on the event stream; a journaled entry is a plain `message` frame (ADR 013).
 * `turn` carries `TurnStarted` and `TurnEnded`, `remote-access` carries `RemoteAccessChanged`,
 * `command-output` carries `CommandOutput`, `memory` carries `MemoryChanged` and `status` carries
 * `ThreadRunChanged`, `HobPresenceChanged` and `HobPresenceRemoved`.
 */
export const STREAM_FRAME = {
  ready: "ready",
  delta: "delta",
  turn: "turn",
  remoteAccess: "remote-access",
  commandOutput: "command-output",
  memory: "memory",
  status: "status",
} as const;
