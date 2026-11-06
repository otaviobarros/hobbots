import {
  type ActivityRecorder,
  deliveredMemoryBrief,
  type HubTools,
  nextSteps,
  type Redactor,
  type RuntimeEvent,
  recordMemoryBrief,
  redactEvent,
  type runtimeAdapters,
  sessionMemoryBrief,
  skillMounter,
  startedMemoryBrief,
  type TaskRepository,
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
  endedSteps,
  previewToolOutput,
  type ReplyStep,
  type ReplyUsage,
  RUNTIME_NAMES,
  stripEscapes,
  systemInstructions,
  type TaskId,
} from "@hobbots/domain";
import { DateTime, Effect, Option, Semaphore, Stream } from "effect";

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
  /** Records the runtime's evidence that it took the turn: its session, and the policy version its tools run under. */
  readonly started: (session: { readonly sessionId: string; readonly policyVersion?: string }) => Effect.Effect<void>;
  /** Records the turn under its hob, runtime and model once the runtime takes it, and what it used once it ends (#1011). */
  readonly turns: Pick<TaskRepository["Service"], "startTurn" | "endTurn">;
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
    const startedAt = DateTime.formatIso(yield* DateTime.now);
    let usage: ReplyUsage | null = null;
    // The turn's steps, kept on its Attempt as a chat reply keeps its own (#892). Saved in order, each
    // change whole; a turn resumed on the Attempt adds to the steps its earlier turns left.
    const stepsLock = yield* Semaphore.make(1);
    let steps: ReadonlyArray<ReplyStep> = [];
    let from = 0;
    const saveSteps = (change: (current: ReadonlyArray<ReplyStep>) => ReadonlyArray<ReplyStep> | null) =>
      Option.isNone(recorder)
        ? Effect.void
        : stepsLock.withPermit(
            Effect.suspend(() => {
              const next = change(steps);
              if (next === null) return Effect.void;
              steps = next;
              return recorder.value.recordSteps(turn.attemptId, next);
            }),
          );
    const stepOf = (event: RuntimeEvent) =>
      Effect.gen(function* () {
        const now = DateTime.formatIso(yield* DateTime.now);
        const redacted = redactEvent(event, redactor);
        const output =
          redacted._tag === "ToolFinished" && redacted.output !== undefined
            ? { ...previewToolOutput(stripEscapes(redactor.text(redacted.output))), logged: false }
            : undefined;
        yield* saveSteps((current) => nextSteps(current, from, redacted, now, output));
      });
    // A step still under way when the turn ends, however it ends, can never read as active again.
    const endSteps = saveSteps((current) => {
      const ended = endedSteps(current);
      return ended.every((step, i) => step === current[i]) ? null : ended;
    });
    if (Option.isSome(recorder)) {
      const earlier = yield* recorder.value.stepsOf(turn.attemptId);
      steps = earlier;
      from = earlier.length;
    }
    const activity = yield* trackTurn(recorder, {
      folders: turn.access?.folders ?? [],
      attempt: Effect.succeed(turn.attemptId),
      redactor,
    });
    // The hob's memory brief (ADR 028), as a chat session gets it: when the session is new, or did not
    // last receive this brief.
    const memory = yield* sessionMemoryBrief(turn.agent.id, turn.access?.folders ?? [], turn.sessionId);
    // The hob's skills (ADR 029), resolved as the turn starts, as a chat's are.
    const skills = yield* (yield* skillMounter)({
      agentId: turn.agent.id,
      policy: turn.config.policy,
      folders: turn.access?.folders ?? [],
    });
    const expected = turn.sessionId === null ? undefined : { sessionId: turn.sessionId };
    // Counted as received only once the runtime answers the prompt that carried it.
    let session: string | null = null;
    let delivered = false;
    // A turn the runtime never took used nothing. One it took is recorded as it starts, so it counts
    // however it ends: with no report when it failed or was stopped, as a chat reply does, or when the
    // hub stopped before it ended.
    const counted = { attemptId: turn.attemptId, startedAt };
    const startTurn = turn.turns.startTurn({
      ...counted,
      agentId: turn.agent.id,
      runtime: turn.config.runtime,
      model: turn.config.model,
    });
    const endTurn = Effect.suspend(() =>
      session === null
        ? Effect.void
        : Effect.flatMap(DateTime.now, (now) => turn.turns.endTurn(counted, usage, DateTime.formatIso(now))),
    );
    const confirmBrief = Effect.suspend(() => {
      const digest = memory === null ? null : deliveredMemoryBrief(memory);
      if (delivered || digest === null || session === null) return Effect.void;
      delivered = true;
      return recordMemoryBrief(session, digest);
    });
    yield* activity
      .run(
        {
          prompt: turn.prompt,
          briefing: memory?.text ?? null,
          sessionId: turn.sessionId,
          instructions: systemInstructions(turn.config.name, turn.config),
          instructionsChanged: false,
          model: turn.config.model,
          effort: turn.config.effort,
          tools: turn.access,
          skills,
          approvals: turn.approvals,
          redaction: redactor,
          recordToolStart: (event) =>
            turn.recordToolStart(event).pipe(Effect.tap((recorded) => (recorded ? stepOf(event) : Effect.void))),
          hubTools: yield* turn.hubTools,
        },
        adapter.sendPrompt,
      )
      .pipe(
        Stream.runForEach((event) => {
          if (event._tag === "SessionStarted") {
            const first = session === null;
            session = event.sessionId;
            return Effect.andThen(
              first ? startTurn : Effect.void,
              turn
                .started({
                  sessionId: event.sessionId,
                  ...(event.policyVersion && { policyVersion: event.policyVersion }),
                })
                .pipe(
                  Effect.andThen(
                    memory === null
                      ? Effect.void
                      : recordMemoryBrief(event.sessionId, startedMemoryBrief(memory, expected, event.sessionId)),
                  ),
                ),
            );
          }
          if (event._tag === "Completed") {
            ending = { _tag: "Replied", text: event.text };
            usage = event.usage ?? null;
          }
          return Effect.andThen(confirmBrief, stepOf(event));
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
        Effect.ensuring(Effect.andThen(endSteps, endTurn)),
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
