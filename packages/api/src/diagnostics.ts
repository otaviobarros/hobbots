import {
  AgentId,
  AttemptId,
  AttemptState,
  BackpackItem,
  BackpackItemId,
  BackpackItemKind,
  BackpackItemState,
  BlockerReason,
  DelegationId,
  MemoryEngineHealth,
  MessageId,
  Quest,
  QuestId,
  QuestState,
  RuntimeAvailability,
  RuntimeHealth,
  RuntimeKind,
  SkillRevisionHash,
  TaskId,
  TaskState,
  TaskTree,
  ThreadId,
  WebLimits,
} from "@hobbots/domain";
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api";
import { QuestNotFound } from "./errors.ts";
import { DeviceSession } from "./user-session.ts";

// Settings › Diagnostics (ADR 026): what is wrong now, one Quest followed across hobs, Tasks,
// Attempts and runtimes by the IDs the hub stores, and a report you can paste anywhere.

/**
 * Work that stopped moving. `claimExpired` is a backpack item whose claim ran out with no turn to
 * renew it; `triesExhausted` a backpack item that failed every delivery and waits for your choice;
 * `noProgress` a running Attempt that recorded nothing for a while.
 */
export const StalledKind = Schema.Literals(["claimExpired", "triesExhausted", "noProgress"]);
export type StalledKind = typeof StalledKind.Type;

export const StalledWork = Schema.Struct({
  kind: StalledKind,
  /** The hob the work waits on. */
  agentId: AgentId,
  taskId: Schema.NullOr(TaskId),
  questId: Schema.NullOr(QuestId),
  attemptId: Schema.NullOr(AttemptId),
  itemId: Schema.NullOr(BackpackItemId),
  /** When it last moved. */
  since: Schema.String,
});
export type StalledWork = typeof StalledWork.Type;

/**
 * What a step of startup recovery does (attempt lifecycle): `endAttempt` ends an Attempt left live
 * by the last process as interrupted; `endStep` ends a step left open without one.
 */
export const RecoveryStep = Schema.Literals(["endAttempt", "endStep"]);
export type RecoveryStep = typeof RecoveryStep.Type;

/** A step of the last startup's recovery that failed, with the error's tag and its redacted message. */
export const RecoveryError = Schema.Struct({
  step: RecoveryStep,
  tag: Schema.String,
  message: Schema.String,
  taskId: Schema.NullOr(TaskId),
  attemptId: Schema.NullOr(AttemptId),
  at: Schema.String,
});
export type RecoveryError = typeof RecoveryError.Type;

/**
 * A skill a hob's next turn gets, as Diagnostics names it (ADR 029): its name, its revision and the
 * scope it comes from. Never its description, instructions or files.
 */
export const DiagnosticsSkill = Schema.Struct({
  name: Schema.String,
  /** The revision's number, shown as r4; null when the hub no longer has that revision. */
  number: Schema.NullOr(Schema.Int),
  revision: SkillRevisionHash,
  scope: Schema.Literals(["Everyone", "Project", "Hob"]),
  /** The set it comes from, whose revision it is (ADR 029, Skill sets); null for a skill of its own. */
  set: Schema.NullOr(Schema.String),
});
export type DiagnosticsSkill = typeof DiagnosticsSkill.Type;

/** One hob's skills, on whichever runtime it thinks with: the ones it loads, and names two projects both define. */
export const DiagnosticsHobSkills = Schema.Struct({
  agentId: AgentId,
  runtime: RuntimeKind,
  skills: Schema.Array(DiagnosticsSkill),
  clashes: Schema.Array(Schema.String),
});
export type DiagnosticsHobSkills = typeof DiagnosticsHobSkills.Type;

/**
 * The Now view: each runtime's health, the memory engine's, stalled work, the last startup's recovery
 * errors and the hold.
 */
export const DiagnosticsNow = Schema.Struct({
  runtimes: Schema.Array(RuntimeHealth),
  /** The memory engine's process (ADR 028); null on a hub that runs none. */
  memory: Schema.NullOr(MemoryEngineHealth),
  stalled: Schema.Array(StalledWork),
  recovery: Schema.Array(RecoveryError),
  /** Whether work is held after a restore until you resume it (ADR 026). */
  workHeld: Schema.Boolean,
  /** When this hub process started, which is when its recovery ran. */
  startedAt: Schema.String,
  /** Each hob that is not retired, with the skills its next turn gets; empty on a hub without skills. */
  skills: Schema.Array(DiagnosticsHobSkills),
});
export type DiagnosticsNow = typeof DiagnosticsNow.Type;

/** A journal entry as Diagnostics shows it: its order, type, time and the IDs it applies to, never its payload. */
export const TraceEntry = Schema.Struct({
  sequence: Schema.Int,
  type: Schema.String,
  occurredAt: Schema.String,
  agentId: Schema.NullOr(AgentId),
  threadId: Schema.NullOr(ThreadId),
  messageId: Schema.NullOr(MessageId),
  taskId: Schema.NullOr(TaskId),
  causationId: Schema.NullOr(Schema.String),
});
export type TraceEntry = typeof TraceEntry.Type;

/**
 * One Quest followed: its tree across hobs with each Task's Delegation and Attempts, the backpack
 * items its work waits on, and its latest journal entries, oldest first.
 */
export const QuestTrace = Schema.Struct({
  quest: Quest,
  tree: TaskTree,
  backpack: Schema.Array(BackpackItem),
  journal: Schema.Array(TraceEntry),
});
export type QuestTrace = typeof QuestTrace.Type;

const Version = Schema.NullOr(Schema.String);

/** Where the report was made. No installation ID, data folder or account. */
export const ReportHub = Schema.Struct({
  version: Schema.String,
  /** The highest migration the database has applied. */
  schemaVersion: Schema.Int,
  storage: Schema.Literals(["sqlite", "postgres"]),
  os: Schema.String,
  arch: Schema.String,
  electron: Version,
  node: Schema.String,
});

export const ReportRuntime = Schema.Struct({
  runtime: RuntimeKind,
  version: Version,
  availability: RuntimeAvailability,
  /** Whether it is signed in, without the account; null when that is not known. */
  signedIn: Schema.NullOr(Schema.Boolean),
});

export const ReportDelegation = Schema.Struct({
  delegationId: DelegationId,
  leadId: AgentId,
  memberId: AgentId,
  createdAt: Schema.String,
});

export const ReportAttempt = Schema.Struct({
  attemptId: AttemptId,
  number: Schema.Int,
  agentId: AgentId,
  runtime: RuntimeKind,
  runtimeSessionId: Schema.NullOr(Schema.String),
  state: AttemptState,
  outcome: Schema.NullOr(Schema.String),
  startedAt: Schema.String,
  endedAt: Schema.NullOr(Schema.String),
});

export const ReportTask = Schema.Struct({
  taskId: TaskId,
  parentTaskId: Schema.NullOr(TaskId),
  agentId: AgentId,
  threadId: Schema.NullOr(ThreadId),
  state: TaskState,
  /** Only when you turn on Include titles. */
  title: Schema.optionalKey(Schema.String),
  createdAt: Schema.String,
  updatedAt: Schema.String,
  delegation: Schema.NullOr(ReportDelegation),
  attempts: Schema.Array(ReportAttempt),
});

export const ReportBackpackItem = Schema.Struct({
  itemId: BackpackItemId,
  kind: BackpackItemKind,
  state: BackpackItemState,
  recipientId: AgentId,
  taskId: Schema.NullOr(TaskId),
  attemptId: Schema.NullOr(AttemptId),
  tries: Schema.Int,
  error: Schema.NullOr(Schema.String),
  blocker: Schema.NullOr(BlockerReason),
  createdAt: Schema.String,
  updatedAt: Schema.String,
});

export const ReportQuest = Schema.Struct({
  questId: QuestId,
  taskId: TaskId,
  leadId: AgentId,
  parentQuestId: Schema.NullOr(QuestId),
  threadId: Schema.NullOr(ThreadId),
  state: QuestState,
  depth: Schema.Int,
  title: Schema.optionalKey(Schema.String),
  createdAt: Schema.String,
  endedAt: Schema.NullOr(Schema.String),
  tasks: Schema.Array(ReportTask),
  backpack: Schema.Array(ReportBackpackItem),
  journal: Schema.Array(TraceEntry),
});

/**
 * Web search and pages read (ADR 036, Usage and limits): the limits and how many sites are blocked,
 * and how many searches and pages every hob made in the last 24 hours. Never a query, a URL or a site.
 */
export const DiagnosticsWeb = Schema.Struct({
  limits: WebLimits,
  blockedSites: Schema.Int,
  lastDay: Schema.Struct({ searches: Schema.Int, pages: Schema.Int }),
});
export type DiagnosticsWeb = typeof DiagnosticsWeb.Type;

/**
 * A diagnostics report (ADR 026). The report is encoded from this schema, which names every field
 * it may hold: a field it does not name is never in a report. Message text, briefs, prompts,
 * replies, Task results, tool steps, command lines, tool output, file contents, skill contents, keychain items,
 * device records and the installation ID are not named, so they never reach one.
 */
export const DiagnosticsReport = Schema.Struct({
  format: Schema.Literal("hobbots.diagnostics"),
  version: Schema.Literal(1),
  createdAt: Schema.String,
  hub: ReportHub,
  runtimes: Schema.Array(ReportRuntime),
  memory: Schema.NullOr(MemoryEngineHealth),
  workHeld: Schema.Boolean,
  stalled: Schema.Array(StalledWork),
  recovery: Schema.Array(RecoveryError),
  /** Each hob's skills by name and revision, never their contents (ADR 029). */
  skills: Schema.Array(DiagnosticsHobSkills),
  /** Absent from a report made before web search was counted. */
  web: Schema.optionalKey(DiagnosticsWeb),
  quest: Schema.NullOr(ReportQuest),
});
export type DiagnosticsReport = typeof DiagnosticsReport.Type;

/**
 * The final check found a credential the hub knows, or a secret's shape, in the report. `field`
 * names where, such as `quest.tasks.1.attempts.0.outcome`; the value is never repeated.
 */
export class DiagnosticsReportRefused extends Schema.TaggedError<DiagnosticsReportRefused>()(
  "DiagnosticsReportRefused",
  { field: Schema.String },
  { httpApiStatus: 409 },
) {}

/** Settings › Diagnostics. Reads only; the hub never sends a report anywhere. */
export class DiagnosticsGroup extends HttpApiGroup.make("diagnostics")
  .add(
    HttpApiEndpoint.get("now", "/diagnostics", { success: DiagnosticsNow }),
    // The Quests to pick from, newest first.
    HttpApiEndpoint.get("quests", "/diagnostics/quests", { success: Schema.Array(Quest) }),
    HttpApiEndpoint.get("trace", "/diagnostics/quests/:questId", {
      params: { questId: QuestId },
      success: QuestTrace,
      error: QuestNotFound,
    }),
    // `?questId=` follows that Quest; `?titles=true` includes Task and Quest titles.
    HttpApiEndpoint.get("report", "/diagnostics/report", {
      query: {
        questId: Schema.optionalKey(QuestId),
        titles: Schema.optionalKey(Schema.Literals(["true", "false"])),
      },
      success: DiagnosticsReport,
      error: [QuestNotFound, DiagnosticsReportRefused],
    }),
  )
  .middleware(DeviceSession)
  .prefix("/api") {}
