import {
  type ActivityRecorder,
  type HubTools,
  type Redactor,
  type runtimeAdapters,
  type ToolAccess,
  type ToolStartedEvent,
  type TurnApprovals,
  trackTurn,
} from "@hobbots/agents";
import {
  type Agent,
  type AgentConfiguration,
  type AgentId,
  type AttemptId,
  RUNTIME_NAMES,
  systemInstructions,
  type TaskId,
} from "@hobbots/domain";
import { Effect, Option, Stream } from "effect";

/** How a session's turn ended: with a final reply, or failed with a reason. */
export type Ending =
  | { readonly _tag: "Replied"; readonly text: string }
  | { readonly _tag: "Failed"; readonly reason: string; readonly limited?: boolean };

/** One turn of a session that works a Task outside any chat: a step's, or a party member's. */
export interface SessionTurn {
  readonly agent: Agent;
  readonly config: AgentConfiguration;
  readonly prompt: string;
  /** The Attempt the turn runs as, which its commands and file changes are recorded on (ADR 023). */
  readonly attemptId: AttemptId;
  /** The runtime session to resume, or null for a fresh one with nothing of the hob's chat. */
  readonly sessionId: string | null;
  readonly access: ToolAccess | null;
  /** Asks you about calls the policy answers Ask for; null, those calls are refused. */
  readonly approvals: TurnApprovals | null;
  readonly recordToolStart: (event: ToolStartedEvent) => Effect.Effect<boolean>;
  /** The hub tools the turn offers, read at its start. */
  readonly hubTools: Effect.Effect<HubTools>;
  /** Records the runtime's evidence that it took the turn: its session. */
  readonly started: (sessionId: string) => Effect.Effect<void>;
}

/** Runs one turn of a Task's own session to its end: its final reply, or why it ended without one. */
export const runSessionTurn = (
  adapters: Effect.Success<typeof runtimeAdapters>,
  redactor: Redactor,
  turn: SessionTurn,
  /** Records what the turn runs and changes for the Workbench (ADR 023); none records nothing. */
  recorder: Option.Option<ActivityRecorder["Service"]> = Option.none(),
): Effect.Effect<Ending> =>
  Effect.gen(function* () {
    const adapter = adapters(turn.config.runtime);
    if (adapter === undefined) {
      return {
        _tag: "Failed",
        reason: `Hobbots cannot run ${RUNTIME_NAMES[turn.config.runtime]} on this hub.`,
      } as Ending;
    }
    let ending: Ending = { _tag: "Failed", reason: "The runtime ended without a result." };
    const activity = yield* trackTurn(recorder, {
      folders: turn.access?.folders ?? [],
      attempt: Effect.succeed(turn.attemptId),
      redactor,
    });
    yield* activity
      .run(
        {
          prompt: turn.prompt,
          briefing: null,
          sessionId: turn.sessionId,
          instructions: systemInstructions(turn.agent.name, turn.config),
          instructionsChanged: false,
          model: turn.config.model,
          effort: turn.config.effort,
          tools: turn.access,
          approvals: turn.approvals,
          redaction: redactor,
          recordToolStart: turn.recordToolStart,
          hubTools: yield* turn.hubTools,
        },
        adapter.sendPrompt,
      )
      .pipe(
        Stream.runForEach((event) => {
          if (event._tag === "SessionStarted") return turn.started(event.sessionId);
          if (event._tag === "Completed") ending = { _tag: "Replied", text: event.text };
          return Effect.void;
        }),
        Effect.catchTags({
          RuntimeError: (error) =>
            Effect.sync(() => {
              ending = { _tag: "Failed", reason: redactor.text(error.message) };
            }),
          RuntimeLimitReached: (error) =>
            Effect.sync(() => {
              ending = {
                _tag: "Failed",
                reason: `The usage limit was reached; it resets at ${error.resetsAt}.`,
                limited: true,
              };
            }),
        }),
      );
    return ending;
  }).pipe(
    // The end-of-turn compare is recorded as the turn's scope closes, however it ended.
    Effect.scoped,
  );

/** Why a running session was stopped, which decides what its Task becomes. */
export type StopReason = "cancel" | "authority" | "hob";

export const STOPPED: Record<StopReason, string> = {
  cancel: "Cancelled.",
  authority: "Stopped because its hob's permissions were narrowed.",
  hob: "Stopped by Hobbots before it finished, with its hob's other work.",
};

/** A session the runner holds open for a Task: a step's, or a party member's turn. */
export interface Running {
  readonly agentId: AgentId;
  readonly rootId: TaskId;
  /** The tools the session started with. */
  readonly access: ToolAccess | null;
  /** What the hob may do on this Task now, to compare against when its policy changes; its own access when absent. */
  readonly accessNow?: Effect.Effect<ToolAccess | null>;
  stop: StopReason | null;
}

/** What the session's hob may do on its Task now: read again for every Charm call (PE-008). */
export const currentAccessOf = (run: Running): Effect.Effect<ToolAccess | null> =>
  run.accessNow ?? Effect.succeed(run.access);
