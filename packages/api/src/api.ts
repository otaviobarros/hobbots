import {
  Agent,
  AgentId,
  AgentStatus,
  Brain,
  Effort,
  HobColor,
  LookSeed,
  Message,
  MessageId,
  ReplyLength,
  RetireWork,
  RoleHat,
  RoleId,
  RoleTool,
  RuntimeHealth,
  RuntimeKind,
  RuntimeModels,
  Thread,
  ThreadId,
  Voice,
} from "@hobbots/domain";
import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiMiddleware } from "effect/http-api";
import { ApprovalsGroup, GrantsGroup } from "./approvals.ts";
import {
  AgentNotFound,
  HobUnavailable,
  InvalidHob,
  MessageNotQueued,
  ReplyNotResumable,
  ThreadNotFound,
} from "./errors.ts";
import { PermissionsGroup } from "./permissions.ts";
import { SearchGroup } from "./search.ts";
import { SetupGroup } from "./setup.ts";

// Short enough for a name tag and a tile; trimmed so "  " is not a name.
const Label = Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(40));

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
});
export type CreateAgentPayload = typeof CreateAgentPayload.Type;

/**
 * An edit of a hob's configuration: only the fields it names change. Each edit that changes
 * something becomes the hob's next configuration version (AG-002).
 */
export const UpdateAgentPayload = Schema.Struct({
  /** A starter role brings its title unless the edit names one. */
  role: Schema.optionalKey(Schema.NullOr(RoleId)),
  roleTitle: Schema.optionalKey(Label),
  sigil: Schema.optionalKey(RoleId),
  hat: Schema.optionalKey(Schema.NullOr(RoleHat)),
  tool: Schema.optionalKey(Schema.NullOr(RoleTool)),
  voice: Schema.optionalKey(Voice),
  length: Schema.optionalKey(ReplyLength),
  lookSeed: Schema.optionalKey(LookSeed),
  lookColor: Schema.optionalKey(HobColor),
  /** A runtime this hub serves; the model and effort are checked against it. */
  runtime: Schema.optionalKey(RuntimeKind),
  model: Schema.optionalKey(Schema.NullOr(Schema.NonEmptyString)),
  effort: Schema.optionalKey(Schema.NullOr(Effort)),
  instructions: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(20_000))),
});
export type UpdateAgentPayload = typeof UpdateAgentPayload.Type;

/** Reports a create or edit request that fails the payload schema as an `InvalidHob` naming the field. */
export class HobInputErrors extends HttpApiMiddleware.Service<HobInputErrors>()("@hobbots/api/HobInputErrors", {
  error: InvalidHob,
}) {}

/** Retiring asks what happens to the hob's running replies; handing them to another hob comes later. */
export const RetireAgentPayload = Schema.Struct({
  activeWork: RetireWork,
});
export type RetireAgentPayload = typeof RetireAgentPayload.Type;

export const SendPromptPayload = Schema.Struct({
  content: Schema.NonEmptyString,
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

/**
 * What the health endpoint returns: enough for a client to tell this installation's server from
 * another installation's, or from a program that is not Hobbots at all (ADR 012).
 */
export const ServerIdentity = Schema.Struct({
  app: Schema.Literal("hobbots"),
  installationId: Schema.NonEmptyString,
  version: Schema.String,
  dataDir: Schema.String,
});
export type ServerIdentity = typeof ServerIdentity.Type;

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
      error: AgentNotFound,
    }),
    HttpApiEndpoint.get("threads", "/agents/:agentId/threads", {
      params: { agentId: AgentId },
      success: Schema.Array(Thread),
      error: AgentNotFound,
    }),
    HttpApiEndpoint.post("createThread", "/agents/:agentId/threads", {
      params: { agentId: AgentId },
      success: Thread,
      error: [AgentNotFound, HobUnavailable],
    }),
  )
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
      error: [ThreadNotFound, HobUnavailable],
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
    // Resumes a reply that was cut off or ended by the provider's limit, in place.
    HttpApiEndpoint.post("continueReply", "/threads/:threadId/messages/:messageId/continue", {
      params: { threadId: ThreadId, messageId: MessageId },
      success: Message,
      error: [ThreadNotFound, HobUnavailable, ReplyNotResumable],
    }),
    // Switches the thread's brain from its next turn; a reply already running keeps its own.
    HttpApiEndpoint.put("setBrain", "/threads/:threadId/brain", {
      params: { threadId: ThreadId },
      payload: SetBrainPayload,
      success: Thread,
      error: [ThreadNotFound, HobUnavailable, InvalidHob, AgentNotFound],
    }),
  )
  .prefix("/api") {}

export class SystemGroup extends HttpApiGroup.make("system")
  .add(
    HttpApiEndpoint.get("health", "/health", { success: ServerIdentity }),
    HttpApiEndpoint.get("activity", "/activity", { success: Activity }),
    HttpApiEndpoint.get("runtimes", "/runtimes", {
      success: Schema.Array(RuntimeHealth),
    }),
  )
  .prefix("/api") {}

/** What each runtime offers a hob's brain. */
export class RuntimesGroup extends HttpApiGroup.make("runtimes")
  .add(
    HttpApiEndpoint.get("models", "/runtimes/:runtime/models", {
      params: { runtime: RuntimeKind },
      success: RuntimeModels,
    }),
  )
  .prefix("/api") {}

export class HobbotsApi extends HttpApi.make("hobbots")
  .add(AgentsGroup)
  .add(ThreadsGroup)
  .add(SystemGroup)
  .add(SetupGroup)
  .add(RuntimesGroup)
  .add(SearchGroup)
  .add(PermissionsGroup)
  .add(ApprovalsGroup)
  .add(GrantsGroup) {}
