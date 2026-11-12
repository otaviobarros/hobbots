import {
  Agent,
  AgentId,
  AgentStatus,
  Brain,
  CarriedOverEntry,
  Effort,
  HOB_LABEL_MAX,
  HobColor,
  HobPresence,
  LookSeed,
  Message,
  MessageId,
  ReplyLength,
  RoleHat,
  RoleId,
  RoleTool,
  RuntimeHealth,
  RuntimeKind,
  RuntimeModels,
  SkillName,
  StartedFresh,
  SummonCaps,
  THREAD_TITLE_MAX,
  Thread,
  ThreadId,
  ThreadRunStatus,
  Voice,
} from "@hobbots/domain";
import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiMiddleware, HttpApiSchema } from "effect/http-api";
import { ApprovalsGroup, GrantsGroup } from "./approvals.ts";
import { BackpackGroup, BlockersGroup } from "./backpack.ts";
import { BackupGroup } from "./backup.ts";
import { MakeCampPayload, ThreadKey } from "./camp-payloads.ts";
import { CampSuggestionsGroup } from "./camp-suggestions.ts";
import { ChaptersGroup } from "./chapters.ts";
import { CharmCallsGroup } from "./charm-calls.ts";
import { DevicesGroup, PairingGroup, PairingRequestsGroup, PairingThrottled } from "./devices.ts";
import { DiagnosticsGroup } from "./diagnostics.ts";
import {
  AgentNotFound,
  HobUnavailable,
  InvalidHob,
  MessageNotQueued,
  ReplyNotResumable,
  StartFreshRefused,
  ThreadArchived,
  ThreadArchiveRefused,
  ThreadKeyReused,
  ThreadNotFound,
  ToolLogNotFound,
} from "./errors.ts";
import { ExportsGroup } from "./export.ts";
import { GitHubGroup } from "./github.ts";
import { HobChangesGroup } from "./hob-changes.ts";
import { HobGitHubAppGroup } from "./hob-github-app.ts";
import { HobMemoryGroup } from "./hob-memory.ts";
import { HobProposalsGroup } from "./hob-proposals.ts";
import { MemoryGroup } from "./memory.ts";
import { MemoryPagesGroup } from "./memory-pages.ts";
import { MemorySharesGroup } from "./memory-shares.ts";
import { PermissionsGroup } from "./permissions.ts";
import { RecordsGroup } from "./records.ts";
import { RemoteAccessGroup } from "./remote-access.ts";
import { HandOverRefused, OpenWork, RetireAgentPayload } from "./retire.ts";
import { SearchGroup } from "./search.ts";
import { SetupGroup } from "./setup.ts";
import { SkillHealthGroup } from "./skill-health.ts";
import { SkillProposalsGroup } from "./skill-proposals.ts";
import { SkillRepositoriesGroup } from "./skill-repositories.ts";
import { SkillTrialsGroup } from "./skill-trials.ts";
import { SkillUpdatesGroup } from "./skill-updates.ts";
import { SkillsGroup } from "./skills.ts";
import { QuestionsGroup, TaskControlsGroup, TasksGroup } from "./tasks.ts";
import { UsageGroup } from "./usage.ts";
import { DeviceSession } from "./user-session.ts";
import { WebGroup } from "./web.ts";
import { WorkbenchGroup } from "./workbench.ts";

// Short enough for a name tag and a tile; trimmed so "  " is not a name.
const Label = Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(HOB_LABEL_MAX));

/** A new hob: who it is, how it looks and what it thinks with. */
export const CreateAgentPayload = Schema.Struct({
  /**
   * An id the client chose, so a retry after a lost response returns the hob created the first
   * time instead of a second one. The server picks one when it is left out.
   */
  id: Schema.optionalKey(AgentId.check(Schema.isUUID())),
  name: Label,
  /** A starter role, or null when the title is the user's own words. */
  role: Schema.NullOr(RoleId),
  /** The starter role's title, or the user's own words. */
  roleTitle: Label,
  /** The starter role whose sigil the hob shows; a custom title can borrow any of them. */
  sigil: RoleId,
  /** The hat and tool the sprite wears, or null to leave them to the look seed. */
  hat: Schema.NullOr(RoleHat),
  tool: Schema.NullOr(RoleTool),
  /**
   * What the hob is good at, for other hobs (ADR 032): one line of up to 200 characters once its
   * whitespace is collapsed, or null for none. Left out, the hub fills in the prefill of the chores
   * in the instructions and the starter role.
   */
  goodAt: Schema.optionalKey(Schema.NullOr(Schema.String)),
  /** How the hob talks; Default and Balanced when left out. */
  voice: Schema.optionalKey(Voice),
  length: Schema.optionalKey(ReplyLength),
  lookSeed: LookSeed,
  lookColor: HobColor,
  runtime: RuntimeKind,
  /** A model from the runtime's list, or null for its default. */
  model: Schema.NullOr(Schema.NonEmptyString),
  /** An effort the model accepts, or null for its default. */
  effort: Schema.NullOr(Effort),
  instructions: Schema.String.check(Schema.isMaxLength(20_000)),
  /** Whether other hobs see this hob in their directory (ADR 032); on when left out. */
  visibleToHobs: Schema.optionalKey(Schema.Boolean),
});
export type CreateAgentPayload = typeof CreateAgentPayload.Type;

/**
 * An edit of a hob's configuration: only the fields it names change. Each edit that changes
 * something becomes the hob's next configuration version (AG-002).
 */
export const UpdateAgentPayload = Schema.Struct({
  name: Schema.optionalKey(Label),
  /** A starter role brings its title unless the edit names one. */
  role: Schema.optionalKey(Schema.NullOr(RoleId)),
  roleTitle: Schema.optionalKey(Label),
  sigil: Schema.optionalKey(RoleId),
  hat: Schema.optionalKey(Schema.NullOr(RoleHat)),
  tool: Schema.optionalKey(Schema.NullOr(RoleTool)),
  /** What the hob is good at, as on create; changing the instructions never changes it. */
  goodAt: Schema.optionalKey(Schema.NullOr(Schema.String)),
  voice: Schema.optionalKey(Voice),
  length: Schema.optionalKey(ReplyLength),
  lookSeed: Schema.optionalKey(LookSeed),
  lookColor: Schema.optionalKey(HobColor),
  /** A runtime this hub serves; the model and effort are checked against it. */
  runtime: Schema.optionalKey(RuntimeKind),
  model: Schema.optionalKey(Schema.NullOr(Schema.NonEmptyString)),
  effort: Schema.optionalKey(Schema.NullOr(Effort)),
  instructions: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(20_000))),
  /** Hidden from or shown to other hobs; it applies from every other hob's next turn (ADR 032). */
  visibleToHobs: Schema.optionalKey(Schema.Boolean),
});
export type UpdateAgentPayload = typeof UpdateAgentPayload.Type;

/** Reports a create or edit request that fails the payload schema as an `InvalidHob` naming the field. */
export class HobInputErrors extends HttpApiMiddleware.Service<HobInputErrors>()("@hobbots/api/HobInputErrors", {
  error: InvalidHob,
}) {}

export const SendPromptPayload = Schema.Struct({
  content: Schema.NonEmptyString,
  /** A skill of the hob's you picked for the message with `/` (ADR 029, Explicit use). */
  skill: Schema.optionalKey(Schema.NullOr(SkillName)),
});

/** A message sent while the thread's reply runs is queued: it has no reply yet (CH-008). */
export const SendPromptResult = Schema.Struct({
  userMessage: Message,
  assistantMessage: Schema.NullOr(Message),
});

/**
 * A thread's own brain, or null to think with the hob's again (ADR 017). With `makeDefault`, the
 * brain becomes the hob's next configuration version instead, and the thread follows the hob.
 */
export const SetBrainPayload = Schema.Struct({
  brain: Schema.NullOr(Brain),
  makeDefault: Schema.optionalKey(Schema.Boolean),
});
export type SetBrainPayload = typeof SetBrainPayload.Type;

/** A chat's new title: trimmed, not empty, and as long as a title made from a first prompt at most. */
export const RenameThreadPayload = Schema.Struct({
  title: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(THREAD_TITLE_MAX)),
});

/** Start fresh on a hob's chat (ADR 037); `key` becomes the new chat's id. */
export const StartFreshPayload = Schema.Struct({ key: ThreadKey });
export type StartFreshPayload = typeof StartFreshPayload.Type;

/** Whether a chat is pinned to the top of its hob's chats. */
export const PinThreadPayload = Schema.Struct({ pinned: Schema.Boolean });

/** The last message you read in the thread (ADR 027). */
/**
 * What you read a thread through (ADR 027): the last message you saw, and the newest message
 * revision you saw up to it, so a reply continued after that is not counted read.
 */
export const MarkThreadReadPayload = Schema.Struct({ messageId: MessageId, revision: Schema.Int });

/**
 * What the health endpoint returns: enough for a client to tell this installation's server from
 * another installation's, or from a program that is not Hobbots at all (ADR 012).
 */
export const ServerIdentity = Schema.Struct({
  app: Schema.Literal("hobbots"),
  /** The hub's name, the computer's own, for "Waiting for approval on <hub name>" (ADR 021). */
  name: Schema.optionalKey(Schema.String),
  installationId: Schema.NonEmptyString,
  version: Schema.String,
  /** The hub's connect protocol (ADR 025); a hub that reports none predates it. */
  connect: Schema.optionalKey(Schema.Int),
  dataDir: Schema.String,
});
export type ServerIdentity = typeof ServerIdentity.Type;

/**
 * What the health endpoint tells a request that did not come from this computer: only that this is
 * Hobbots, which version and which connect protocol, for the waiting screen and a connected desktop. The installation ID and data folder stay local
 * (ADR 021).
 */
export const PublicServerIdentity = Schema.Struct({
  app: Schema.Literal("hobbots"),
  name: Schema.optionalKey(Schema.String),
  version: Schema.String,
  /** The hub's connect protocol, so a connected desktop knows which side to update (ADR 025). */
  connect: Schema.optionalKey(Schema.Int),
});
export type PublicServerIdentity = typeof PublicServerIdentity.Type;

/** A hob with a turn in progress. */
export const WorkingHob = Schema.Struct({
  agentId: AgentId,
  name: Schema.String,
  threadId: ThreadId,
});

/** What the hub is doing right now; the desktop app asks before closing would stop the work. */
export const Activity = Schema.Struct({
  working: Schema.Array(WorkingHob),
});

/**
 * The status the hub decides (ADR 037), for the sync snapshot: every thread whose run is not idle
 * and every live hob's presence, each with the revision of the last change of its kind, so a thread
 * or hob left out has none as of it. Revisions count from the hub's start, so on every `Ready` a
 * client drops the status it held and reads this again. It then keeps, per thread and per hob,
 * whichever of this and each later `status` event has the higher revision.
 */
export const HubStatus = Schema.Struct({
  runsRevision: Schema.Int,
  runs: Schema.Array(ThreadRunStatus),
  presenceRevision: Schema.Int,
  hobs: Schema.Array(HobPresence),
});
export type HubStatus = typeof HubStatus.Type;

export class AgentsGroup extends HttpApiGroup.make("agents")
  .add(
    // Without a status, lists the hobs that are not retired; `?status=retired` lists Archived hobs.
    HttpApiEndpoint.get("list", "/agents", {
      query: { status: Schema.optionalKey(AgentStatus) },
      success: Schema.Array(Agent),
    }),
    HttpApiEndpoint.post("create", "/agents", {
      payload: CreateAgentPayload,
      success: Agent,
      error: InvalidHob,
    }).middleware(HobInputErrors),
    HttpApiEndpoint.patch("update", "/agents/:agentId", {
      params: { agentId: AgentId },
      payload: UpdateAgentPayload,
      success: Agent,
      error: [InvalidHob, AgentNotFound],
    }).middleware(HobInputErrors),
    HttpApiEndpoint.post("pause", "/agents/:agentId/pause", {
      params: { agentId: AgentId },
      success: Agent,
      error: [AgentNotFound, HobUnavailable],
    }),
    HttpApiEndpoint.post("wake", "/agents/:agentId/wake", {
      params: { agentId: AgentId },
      success: Agent,
      error: [AgentNotFound, HobUnavailable],
    }),
    HttpApiEndpoint.post("retire", "/agents/:agentId/retire", {
      params: { agentId: AgentId },
      payload: RetireAgentPayload,
      success: Agent,
      error: [AgentNotFound, HobUnavailable, HandOverRefused],
    }),
    // What the hob still has open, for Retire to list; `?handOverTo=` checks each Task against that hob.
    HttpApiEndpoint.get("openWork", "/agents/:agentId/open-work", {
      params: { agentId: AgentId },
      query: { handOverTo: Schema.optionalKey(AgentId) },
      success: OpenWork,
      error: AgentNotFound,
    }),
    // Brings a retired hob back, active with all its threads; refused for a paused hob.
    HttpApiEndpoint.post("bringBack", "/agents/:agentId/bring-back", {
      params: { agentId: AgentId },
      success: Agent,
      error: [AgentNotFound, HobUnavailable],
    }),
    // Lists the hob's live threads; `?archived=true` lists its archived ones, newest-archived first.
    HttpApiEndpoint.get("threads", "/agents/:agentId/threads", {
      params: { agentId: AgentId },
      query: { archived: Schema.optionalKey(Schema.Literals(["true", "false"])) },
      success: Schema.Array(Thread),
      error: AgentNotFound,
    }),
    HttpApiEndpoint.post("createThread", "/agents/:agentId/threads", {
      params: { agentId: AgentId },
      success: Thread,
      error: [AgentNotFound, HobUnavailable],
    }),
    // Makes a camp for the hob (ADR 037); the same request sent again returns the camp it made.
    HttpApiEndpoint.post("makeCamp", "/agents/:agentId/camps", {
      params: { agentId: AgentId },
      payload: MakeCampPayload,
      success: Thread,
      error: [AgentNotFound, HobUnavailable, ThreadKeyReused],
    }),
    // The hob's live hobs summoned without asking you, and the caps on them (ADR 034).
    HttpApiEndpoint.get("summonCaps", "/agents/:agentId/summon-caps", {
      params: { agentId: AgentId },
      success: SummonCaps,
      error: AgentNotFound,
    }),
  )
  .middleware(DeviceSession)
  .prefix("/api") {}

export class ThreadsGroup extends HttpApiGroup.make("threads")
  .add(
    HttpApiEndpoint.get("messages", "/threads/:threadId/messages", {
      params: { threadId: ThreadId },
      success: Schema.Array(Message),
      error: ThreadNotFound,
    }),
    HttpApiEndpoint.post("sendPrompt", "/threads/:threadId/messages", {
      params: { threadId: ThreadId },
      payload: SendPromptPayload,
      success: SendPromptResult,
      error: [ThreadNotFound, HobUnavailable, ThreadArchived],
    }),
    HttpApiEndpoint.delete("removeQueued", "/threads/:threadId/messages/:messageId", {
      params: { threadId: ThreadId, messageId: MessageId },
      error: [ThreadNotFound, MessageNotQueued],
    }),
    // Stops the running reply, if any, and starts this queued message next.
    HttpApiEndpoint.post("sendNow", "/threads/:threadId/messages/:messageId/send-now", {
      params: { threadId: ThreadId, messageId: MessageId },
      error: [ThreadNotFound, MessageNotQueued],
    }),
    HttpApiEndpoint.post("interrupt", "/threads/:threadId/interrupt", {
      params: { threadId: ThreadId },
      error: ThreadNotFound,
    }),
    // Stop waiting: ends a reply that only waits on commands its hob started, keeping its text (#1056).
    HttpApiEndpoint.post("stopWaiting", "/threads/:threadId/stop-waiting", {
      params: { threadId: ThreadId },
      error: ThreadNotFound,
    }),
    // Resumes a reply that was cut off or ended by the provider's limit, in place.
    HttpApiEndpoint.post("continueReply", "/threads/:threadId/messages/:messageId/continue", {
      params: { threadId: ThreadId, messageId: MessageId },
      success: Message,
      error: [ThreadNotFound, HobUnavailable, ReplyNotResumable, ThreadArchived],
    }),
    // The whole redacted output of a tool step that shows only its start and end, as plain text.
    HttpApiEndpoint.get("toolLog", "/threads/:threadId/messages/:messageId/steps/:stepId/log", {
      params: { threadId: ThreadId, messageId: MessageId, stepId: Schema.String },
      success: Schema.String.pipe(HttpApiSchema.asText({ contentType: "text/plain; charset=utf-8" })),
      error: ToolLogNotFound,
    }),
    // Switches the thread's brain from its next turn; a reply already running keeps its own.
    HttpApiEndpoint.put("setBrain", "/threads/:threadId/brain", {
      params: { threadId: ThreadId },
      payload: SetBrainPayload,
      success: Thread,
      error: [ThreadNotFound, HobUnavailable, InvalidHob, AgentNotFound, ThreadArchived],
    }),
    // Renaming or pinning a chat leaves its place by last activity; an archived chat refuses both.
    HttpApiEndpoint.put("rename", "/threads/:threadId/title", {
      params: { threadId: ThreadId },
      payload: RenameThreadPayload,
      success: Thread,
      error: [ThreadNotFound, ThreadArchived],
    }),
    HttpApiEndpoint.put("pin", "/threads/:threadId/pinned", {
      params: { threadId: ThreadId },
      payload: PinThreadPayload,
      success: Thread,
      error: [ThreadNotFound, ThreadArchived],
    }),
    // Moves how far you read the thread forward, for every device; never back (ADR 027).
    HttpApiEndpoint.put("markRead", "/threads/:threadId/read", {
      params: { threadId: ThreadId },
      payload: MarkThreadReadPayload,
      success: Thread,
      error: ThreadNotFound,
    }),
    // Archiving again, or restoring a live thread, returns the thread unchanged.
    HttpApiEndpoint.post("archive", "/threads/:threadId/archive", {
      params: { threadId: ThreadId },
      success: Thread,
      error: [ThreadNotFound, ThreadArchiveRefused],
    }),
    HttpApiEndpoint.post("restore", "/threads/:threadId/restore", {
      params: { threadId: ThreadId },
      success: Thread,
      error: [ThreadNotFound, ThreadArchiveRefused],
    }),
    // Supersedes the hob's chat and opens a new one with what it still owed (ADR 037); the same
    // request sent again returns what it did.
    HttpApiEndpoint.post("startFresh", "/threads/:threadId/start-fresh", {
      params: { threadId: ThreadId },
      payload: StartFreshPayload,
      success: StartedFresh,
      error: [ThreadNotFound, StartFreshRefused, ThreadKeyReused],
    }),
    // What Start fresh would carry over from the thread now (ADR 037), so its sheet can list it; it changes nothing.
    HttpApiEndpoint.get("carryOver", "/threads/:threadId/carry-over", {
      params: { threadId: ThreadId },
      success: Schema.Array(CarriedOverEntry),
      error: ThreadNotFound,
    }),
  )
  .middleware(DeviceSession)
  .prefix("/api") {}

/**
 * The health endpoint answers without a device, so a client can tell this hub from another program
 * before it has a token (ADR 012, ADR 021).
 */
export class HealthGroup extends HttpApiGroup.make("health")
  .add(
    // A tailnet node without a device that asks too often is throttled, as pairing is (ADR 021).
    HttpApiEndpoint.get("health", "/health", {
      success: Schema.Union([ServerIdentity, PublicServerIdentity]),
      error: PairingThrottled,
    }),
  )
  .prefix("/api") {}

export class SystemGroup extends HttpApiGroup.make("system")
  .add(
    HttpApiEndpoint.get("activity", "/activity", { success: Activity }),
    HttpApiEndpoint.get("status", "/status", { success: HubStatus }),
    HttpApiEndpoint.get("runtimes", "/runtimes", {
      success: Schema.Array(RuntimeHealth),
    }),
  )
  .middleware(DeviceSession)
  .prefix("/api") {}

/** What each runtime offers a hob's brain. */
export class RuntimesGroup extends HttpApiGroup.make("runtimes")
  .add(
    HttpApiEndpoint.get("models", "/runtimes/:runtime/models", {
      params: { runtime: RuntimeKind },
      success: RuntimeModels,
    }),
  )
  .middleware(DeviceSession)
  .prefix("/api") {}

export class HobbotsApi extends HttpApi.make("hobbots")
  .add(HealthGroup)
  .add(PairingGroup)
  .add(PairingRequestsGroup)
  .add(DevicesGroup)
  .add(AgentsGroup)
  .add(HobChangesGroup)
  .add(ThreadsGroup)
  .add(ChaptersGroup)
  .add(RecordsGroup)
  .add(CampSuggestionsGroup)
  .add(SystemGroup)
  .add(SetupGroup)
  .add(RuntimesGroup)
  .add(SearchGroup)
  .add(PermissionsGroup)
  .add(ApprovalsGroup)
  .add(GrantsGroup)
  .add(CharmCallsGroup)
  .add(TasksGroup)
  .add(TaskControlsGroup)
  .add(QuestionsGroup)
  .add(BackpackGroup)
  .add(BlockersGroup)
  .add(GitHubGroup)
  .add(HobGitHubAppGroup)
  .add(RemoteAccessGroup)
  .add(WorkbenchGroup)
  .add(BackupGroup)
  .add(DiagnosticsGroup)
  .add(ExportsGroup)
  .add(UsageGroup)
  .add(WebGroup)
  .add(MemoryGroup)
  .add(MemoryPagesGroup)
  .add(MemorySharesGroup)
  .add(HobMemoryGroup)
  .add(SkillsGroup)
  .add(SkillProposalsGroup)
  .add(HobProposalsGroup)
  .add(SkillUpdatesGroup)
  .add(SkillTrialsGroup)
  .add(SkillHealthGroup)
  .add(SkillRepositoriesGroup) {}
