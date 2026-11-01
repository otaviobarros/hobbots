import {
  type ApprovalId,
  type Effort,
  type Grant,
  type GrantId,
  type GrantRule,
  type HobPolicy,
  type PolicyOperation,
  type PolicyOverrides,
  RUNTIME_NAMES,
  type RuntimeEnforcement,
  RuntimeHealth,
  type RuntimeKind,
  RuntimeModels,
  type SafetyPreset,
} from "@hobbots/domain";
import { Context, Effect, Option, Schema, type Stream } from "effect";
import type { Redactor } from "./secrets.ts";

/** The policy allowed a tool call and it began. `id` is unique within the turn. */
export interface ToolStartedEvent {
  readonly _tag: "ToolStarted";
  readonly id: string;
  /** The runtime's own name for the tool, such as `Bash` or `Edit`. */
  readonly tool: string;
  readonly operation: PolicyOperation;
  /** The canonical paths, the command's folder, or the remote the call was decided on. */
  readonly targets: ReadonlyArray<string>;
  /** Short words for the step, such as "Running pnpm test". */
  readonly label: string;
}

/** Normalized runtime output. Vendor message shapes stay inside each adapter. */
export type RuntimeEvent =
  | {
      readonly _tag: "SessionStarted";
      readonly sessionId: string;
      readonly billing: string | null;
    }
  | { readonly _tag: "TextDelta"; readonly text: string }
  /** The runtime began something other than writing, such as thinking. `id` is unique within the turn. */
  | {
      readonly _tag: "StepStarted";
      readonly id: string;
      readonly kind: "thinking" | "tool";
      readonly label: string;
    }
  | { readonly _tag: "StepEnded"; readonly id: string }
  | ToolStartedEvent
  /**
   * The policy answered Ask: the tool call waits for the user's decision on `approvalId`. It then
   * starts with the same `id`, or is denied.
   */
  | {
      readonly _tag: "ToolAwaitingApproval";
      readonly id: string;
      readonly approvalId: ApprovalId;
      readonly tool: string;
      readonly operation: PolicyOperation;
      readonly targets: ReadonlyArray<string>;
      readonly label: string;
    }
  /**
   * A started tool call ended; `failed` when the tool reported an error, a sandbox refusal included.
   * `output` is what the call printed, or its error, whole: Hobbots redacts and cuts it, never the adapter.
   */
  | { readonly _tag: "ToolFinished"; readonly id: string; readonly failed: boolean; readonly output?: string }
  /** A tool call never ran: the policy refused it, the user denied it, or its approval expired. */
  | {
      readonly _tag: "ToolDenied";
      readonly id: string;
      readonly tool: string;
      readonly operation: PolicyOperation;
      readonly targets: ReadonlyArray<string>;
      readonly label: string;
      readonly reason: string;
      /** Who refused it: the policy hook, the user answering an Ask, or the OS sandbox around the runtime. */
      readonly decidedBy: "policy" | "user" | "sandbox";
    }
  | {
      readonly _tag: "Completed";
      readonly sessionId: string;
      readonly text: string;
    };

export class RuntimeError extends Schema.TaggedError<RuntimeError>()("RuntimeError", {
  message: Schema.String,
}) {}

/** The provider refused the turn because its usage limit was reached. */
export class RuntimeLimitReached extends Schema.TaggedError<RuntimeLimitReached>()("RuntimeLimitReached", {
  /** When the allowance refills (ISO 8601), if the provider said. */
  resetsAt: Schema.NullOr(Schema.String),
}) {}

/**
 * The policy a turn's tools run under: the policy engine's context without what only the adapter
 * knows (its sandbox and its model API's hosts).
 */
export interface ToolPolicy {
  readonly preset: SafetyPreset;
  /** Folders approved in setup, which every hob can work in unless it hides one. */
  readonly sharedFolders: ReadonlyArray<string>;
  readonly hob: HobPolicy;
  /** Hobbots' own data folder, never reachable even when a shared folder contains it. */
  readonly dataFolder: string;
  /** Narrowing added by the thread, Quest, task or delegation. Each may only narrow. */
  readonly restrictions: ReadonlyArray<PolicyOverrides>;
}

/**
 * What a hob may do with tools this turn (ADR 014). The adapter adds what only it knows: whether
 * its sandbox can start and which hosts its model API needs.
 */
export interface ToolAccess {
  readonly policy: ToolPolicy;
  /** The hob's effective folders, canonical; the first is where the runtime starts. */
  readonly folders: ReadonlyArray<string>;
  /**
   * Where the runtime keeps this hob's own state, such as its sessions, when it runs with tools. Its
   * parent holds every hob's and stays closed to the others.
   */
  readonly runtimeFolder: string;
}

/** A tool call the policy answered Ask for, as an adapter asks the user about it (PE-003). */
export interface ApprovalAction {
  /** The runtime's id for the call, which is also its reply step's. */
  readonly stepId: string;
  readonly tool: string;
  readonly operation: PolicyOperation;
  readonly targets: ReadonlyArray<string>;
  /** The call's concrete arguments, exactly as the runtime would run them. */
  readonly arguments: Readonly<Record<string, unknown>>;
  readonly label: string;
  /** Why the policy asks. */
  readonly reason: string;
  /** The policy version the call was decided under. */
  readonly policyVersion: string;
  /** A high-risk action, approved once only and with the user's confirmation. */
  readonly onceOnly: boolean;
  /** Whether a saved rule could answer it, so This Quest and Always are offered (ADR 015). */
  readonly grantable: boolean;
  /** The rules Always would save, for a grantable action. */
  readonly rules: ReadonlyArray<GrantRule>;
}

/**
 * The user's answer. Approved names the action and policy it applies to, so the adapter can check
 * both again just before the call runs (PE-008). Expired: the request can no longer be decided.
 */
export type ApprovalOutcome =
  | { readonly _tag: "Approved"; readonly actionDigest: string; readonly policyVersion: string }
  | { readonly _tag: "Denied"; readonly reason: string | null }
  | { readonly _tag: "Expired" };

/** A stored request and the wait for its decision. */
export interface PendingApproval {
  readonly approvalId: ApprovalId;
  readonly decision: Effect.Effect<ApprovalOutcome>;
}

/** How a turn asks the user to approve a tool call and waits for the answer. */
export interface TurnApprovals {
  /** Stores a pending request for the action. A turn that has ended gets one that is already expired. */
  readonly request: (action: ApprovalAction) => Effect.Effect<PendingApproval>;
  /** The hob's tool access now, to decide an approved call again just before it runs (PE-008). */
  readonly currentAccess: Effect.Effect<ToolAccess | null>;
  /** The hob's live grants now, read again for every call so a revocation applies to the next (PE-008). */
  readonly grants: Effect.Effect<ReadonlyArray<Grant>>;
  /** Records that these grants answered a call. */
  readonly used: (grantIds: ReadonlyArray<GrantId>) => Effect.Effect<void>;
}

export interface PromptRequest {
  readonly prompt: string;
  /**
   * What the session missed while other brains replied in the thread (ADR 017), to deliver ahead of
   * the prompt in the same turn. Absent or null when it saw everything.
   */
  readonly briefing?: string | null;
  /** Runtime session to resume, or null to start a new one. */
  readonly sessionId: string | null;
  readonly instructions: string;
  /**
   * The resumed session may follow other instructions, as after an edit. Claude Code keeps a resumed
   * session's first system prompt, so an adapter then delivers them inside the turn.
   */
  readonly instructionsChanged: boolean;
  /** The hob's model, or null for the runtime's default. */
  readonly model: string | null;
  /** The hob's effort, or null for the model's default. */
  readonly effort: Effort | null;
  /** Tools under the hob's policy; absent, null or without folders, the turn is chat-only. */
  readonly tools?: ToolAccess | null;
  /** Asks the user about calls the policy answers Ask for; absent or null, those calls are refused. */
  readonly approvals?: TurnApprovals | null;
  /**
   * Redacts secrets from what the adapter reports about a tool call, before it shortens a label. An
   * adapter that puts a credential in the tools' environment remembers it here.
   */
  readonly redaction?: Redactor | null;
  /**
   * Records a tool call the policy allowed, durably, before it runs (EX-004). The adapter waits for
   * it and then lets the call run without reporting it again; false, or a defect, and the call is
   * refused, so no call ever runs without a record. Absent or null, the adapter reports the call as
   * it starts.
   */
  readonly recordToolStart?: ((event: ToolStartedEvent) => Effect.Effect<boolean>) | null;
}

/** Why a tool call is refused when Hobbots could not record it before it ran. */
export const UNRECORDED_TOOL_CALL = "Hobbots could not record this step before it ran, so it did not run.";

export interface RuntimeAdapterShape {
  readonly health: Effect.Effect<RuntimeHealth>;
  /** Models a hob can choose, from the runtime when it reports them, otherwise a documented list. */
  readonly models: Effect.Effect<RuntimeModels>;
  /** What this adapter enforces on this hub, for the hob profile; health reports the same. */
  readonly enforcement: Effect.Effect<RuntimeEnforcement>;
  /** Runs one turn. Interrupting the stream cancels the turn. */
  readonly sendPrompt: (request: PromptRequest) => Stream.Stream<RuntimeEvent, RuntimeError | RuntimeLimitReached>;
}

/** The Claude Code adapter, the runtime every hub serves. */
export class RuntimeAdapter extends Context.Service<RuntimeAdapter, RuntimeAdapterShape>()(
  "@hobbots/agents/RuntimeAdapter",
) {}

/** Adapters for the other runtimes this hub serves, by kind (ADR 017). Absent, it serves Claude Code only. */
export class AdditionalRuntimes extends Context.Service<
  AdditionalRuntimes,
  ReadonlyMap<RuntimeKind, RuntimeAdapterShape>
>()("@hobbots/agents/AdditionalRuntimes") {}

/** Finds the adapter for a runtime, or none when this hub cannot run it. */
export type RuntimeAdapters = (runtime: RuntimeKind) => RuntimeAdapterShape | undefined;

/** The adapter of each runtime the hub serves: Claude Code's, then any additional ones. */
export const runtimeAdapters: Effect.Effect<RuntimeAdapters, never, RuntimeAdapter> = Effect.gen(function* () {
  const claude = yield* RuntimeAdapter;
  const others = Option.getOrElse(yield* Effect.serviceOption(AdditionalRuntimes), () => new Map());
  return (runtime) => (runtime === "claude-code" ? claude : others.get(runtime));
});

const unsupported = { status: "unsupported", evidence: "This hub has no adapter for the runtime." } as const;

/** The health of a runtime this hub has no adapter for: unavailable, and enforcing nothing. */
export const missingRuntimeHealth = (runtime: RuntimeKind): RuntimeHealth =>
  new RuntimeHealth({
    runtime,
    availability: "unavailable",
    billing: null,
    version: null,
    detail: `Hobbots cannot run ${RUNTIME_NAMES[runtime]} yet`,
    checkedAt: null,
    enforcement: {
      toolInterception: unsupported,
      processSandbox: unsupported,
      hubTools: unsupported,
      toolEvents: unsupported,
      toolInterruption: unsupported,
    },
  });

/** The models of a runtime this hub has no adapter for: none. */
export const missingRuntimeModels = (runtime: RuntimeKind): RuntimeModels =>
  new RuntimeModels({ runtime, source: "fallback", models: [] });
