import type { Effort, PolicyOperation, RuntimeHealth, RuntimeModels } from "@hobbots/domain";
import type { PolicyContext } from "@hobbots/permissions";
import { Context, type Effect, Schema, type Stream } from "effect";

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
  /** The policy allowed a tool call and it began. `id` is unique within the turn. */
  | {
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
  /** A started tool call ended; `failed` when the tool reported an error, a sandbox refusal included. */
  | { readonly _tag: "ToolFinished"; readonly id: string; readonly failed: boolean }
  /** A tool call never ran: the policy refused it, or it needed an approval Hobbots cannot ask for yet. */
  | {
      readonly _tag: "ToolDenied";
      readonly id: string;
      readonly tool: string;
      readonly operation: PolicyOperation;
      readonly targets: ReadonlyArray<string>;
      readonly label: string;
      readonly reason: string;
      /** Who refused it: the policy hook, or the OS sandbox around the runtime. */
      readonly decidedBy: "policy" | "sandbox";
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
 * What a hob may do with tools this turn (ADR 014). The adapter adds what only it knows: whether
 * its sandbox can start and which hosts its model API needs.
 */
export interface ToolAccess {
  readonly policy: Omit<PolicyContext, "sandbox" | "modelHosts">;
  /** The hob's effective folders, canonical; the first is where the runtime starts. */
  readonly folders: ReadonlyArray<string>;
  /**
   * Where the runtime keeps this hob's own state, such as its sessions, when it runs with tools. Its
   * parent holds every hob's and stays closed to the others.
   */
  readonly runtimeFolder: string;
}

export interface PromptRequest {
  readonly prompt: string;
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
}

/** Whether an enforcement capability holds for the installed runtime on this hub (ADR 014). */
export interface CapabilityStatus {
  readonly status: "verified" | "unsupported" | "unverified";
  readonly evidence: string;
}

/** What an adapter enforces. An unverified capability counts as missing. */
export interface EnforcementDeclaration {
  /** Every tool call reaches the policy hook first, and nothing is loaded from settings on disk. */
  readonly toolInterception: CapabilityStatus;
  /** The runtime starts inside Hobbots' sandbox. Without it, commands and the web are blocked. */
  readonly processSandbox: CapabilityStatus;
  /** Charms and coordination tools served over the runtime's control channel. */
  readonly hubTools: CapabilityStatus;
  /** Tool start, finish and denial are reported. */
  readonly toolEvents: CapabilityStatus;
  /** A running tool can be stopped. */
  readonly toolInterruption: CapabilityStatus;
}

export interface RuntimeAdapterShape {
  readonly health: Effect.Effect<RuntimeHealth>;
  /** Models a hob can choose, from the runtime when it reports them, otherwise a documented list. */
  readonly models: Effect.Effect<RuntimeModels>;
  /** What this adapter enforces on this hub, as evidence for health and the docs; absent, it claims nothing. */
  readonly enforcement?: Effect.Effect<EnforcementDeclaration>;
  /** Runs one turn. Interrupting the stream cancels the turn. */
  readonly sendPrompt: (request: PromptRequest) => Stream.Stream<RuntimeEvent, RuntimeError | RuntimeLimitReached>;
}

export class RuntimeAdapter extends Context.Service<RuntimeAdapter, RuntimeAdapterShape>()(
  "@hobbots/runtimes/RuntimeAdapter",
) {}
