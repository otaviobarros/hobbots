import {
  type ActivityRecorder,
  contextBlock,
  deliveredMemoryBrief,
  deliveredRoster,
  type HubOffer,
  makeWebMark,
  makeWebProvenance,
  nextSteps,
  type Redactor,
  type RuntimeEvent,
  recordMemoryBrief,
  recordRoster,
  redactEvent,
  type runtimeAdapters,
  sessionMemoryBrief,
  sessionRoster,
  skillMounter,
  skillUseRecorder,
  startedMemoryBrief,
  startedRoster,
  type TaskRepository,
  type ToolAccess,
  type ToolStartedEvent,
  type TurnApprovals,
  TurnSkillsInUse,
  type TurnSteers,
  trackTurn,
  webMarkBriefing,
  webSearchRequest,
  webSearchTurn,
  webWorkOf,
  withWebMark,
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
  type RosterMark,
  RUNTIME_NAMES,
  stripEscapes,
  systemInstructions,
  type TaskId,
  type ThreadId,
  type WebReadMark,
} from "@hobbots/domain";
import { DateTime, Effect, Option, Semaphore, Stream } from "effect";
import { markOfSession } from "./web-marks.ts";

/** How a session's turn ended: with a final reply, or failed with a reason. */
export type Ending =
  | { readonly _tag: "Replied"; readonly text: string }
  | { readonly _tag: "Failed"; readonly reason: string; readonly limited?: boolean };

/** One turn of a session that works a Task outside any chat: a step's, or a party member's. */
export interface SessionTurn {
  readonly agent: Agent;
  readonly config: AgentConfiguration;
  readonly prompt: string;
  /** The Task the session works on, whose found URLs (ADR 036) a search's results join. */
  readonly taskId: TaskId;
  /** The Attempt the turn runs as, which its commands and file changes are recorded on (ADR 023). */
  readonly attemptId: AttemptId;
  /** The chat the Task belongs to, which its web records name (ADR 036). */
  readonly threadId: ThreadId | null;
  /** The runtime session to resume, or null for a fresh one with nothing of the hob's chat. */
  readonly sessionId: string | null;
  readonly access: ToolAccess | null;
  /** Asks you about calls the policy answers Ask for; null, those calls are refused. */
  readonly approvals: TurnApprovals | null;
  readonly recordToolStart: (event: ToolStartedEvent) => Effect.Effect<boolean>;
  /**
   * The hub tools the turn offers, and how the hub steers its runtime's own calls, read at its start,
   * for the approvals the turn's calls are decided with: `approvals` with its session's read-the-web
   * mark (ADR 036).
   */
  readonly offer: (approvals: TurnApprovals) => Effect.Effect<HubOffer>;
  /** Records the runtime's evidence that it took the turn: its session, and the policy version its tools run under. */
  readonly started: (session: { readonly sessionId: string; readonly policyVersion?: string }) => Effect.Effect<void>;
  /**
   * Records the turn under its hob, runtime and model once the runtime takes it, and what it used once
   * it ends (#1011), and reads its Task's Attempts for the mark its session holds (ADR 036).
   */
  readonly turns: Pick<TaskRepository["Service"], "startTurn" | "endTurn" | "readTree">;
  /** Keeps its session's read-the-web mark on its Attempt, announced for a Workbench already open (ADR 036). */
  readonly keepMark: (mark: WebReadMark) => Effect.Effect<void>;
  /** Messages that reach the turn while it runs (#1345), such as its lead's; absent, it gets none. */
  readonly steers?: TurnSteers;
}

/** The read-the-web mark the session a turn resumes holds (ADR 036). A fresh session holds none. */
const sessionMark = (turn: SessionTurn) => {
  const { sessionId } = turn;
  return sessionId === null
    ? Effect.succeed(null)
    : Effect.map(turn.turns.readTree(turn.taskId), (tree) =>
        Option.match(tree, { onNone: () => null, onSome: ({ attempts }) => markOfSession(attempts, sessionId) }),
      );
};

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
    const web = yield* makeWebProvenance;
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
    // The other hobs on the hub (ADR 032), as a chat session gets them.
    const roster = yield* sessionRoster({
      agentId: turn.agent.id,
      access: turn.access,
      redactor,
      sessionId: turn.sessionId,
      keepsTools: adapter.resumeKeepsHubTools === true,
    });
    // The hob's skills (ADR 029), resolved as the turn starts, as a chat's are.
    const mounter = yield* skillMounter;
    const given = yield* mounter.resolve({
      agentId: turn.agent.id,
      policy: turn.config.policy,
      folders: turn.access?.folders ?? [],
    });
    const skills = yield* mounter.mounts(given);
    // Its skill uses are counted for the hob; a session's turn has no reply of yours to show them under.
    const skillUses = yield* skillUseRecorder({ agentId: turn.agent.id, threadId: null, messageId: null });
    skillUses.given(given);
    const expected = turn.sessionId === null ? undefined : { sessionId: turn.sessionId };
    // The session's read-the-web mark (ADR 036): a resumed session holds the one an Attempt of the
    // Task recorded for it, and the turn keeps every change on its own Attempt.
    const markedBefore = yield* sessionMark(turn);
    // A new Attempt that resumes a marked session holds the mark from its start, read again or not.
    if (markedBefore !== null) yield* turn.keepMark(markedBefore);
    const webMark = yield* makeWebMark(markedBefore, turn.keepMark);
    const approvals = withWebMark(turn.approvals, webMark, Effect.succeed(turn.access));
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
    // What the session holds of the roster once the runtime started it, until the prompt is answered.
    let rosterMark: RosterMark | null = null;
    const confirmBrief = Effect.suspend(() => {
      const digest = memory === null ? null : deliveredMemoryBrief(memory);
      const rostered = roster?.sent === true && rosterMark !== null;
      if (delivered || (digest === null && !rostered) || session === null) return Effect.void;
      delivered = true;
      return Effect.andThen(
        digest === null ? Effect.void : recordMemoryBrief(session, digest),
        roster === null || rosterMark === null || !rostered
          ? Effect.void
          : recordRoster(session, deliveredRoster(roster, rosterMark)),
      );
    });
    // What the turn searched is recorded, against the hob's web limits (ADR 036, Usage and limits).
    const webUse = yield* webSearchTurn({
      agentId: turn.agent.id,
      threadId: turn.threadId,
      messageId: null,
      runtime: turn.config.runtime,
      work: webWorkOf({ threadId: null, taskId: turn.taskId }),
      taskId: Effect.succeed(turn.taskId),
      attemptId: Effect.succeed(turn.attemptId),
    });
    const search = webSearchRequest(turn.access, webUse, adapter);
    // A hub tool reads the revisions this turn mounted, not what a rollout moved since.
    const { notOffered, ...offer } = yield* Effect.provideService(turn.offer(approvals), TurnSkillsInUse, given);
    // A call to a tool the session was not offered is recorded on its Task, with why it lacks it (#1356).
    const explained = (event: RuntimeEvent): Effect.Effect<RuntimeEvent> =>
      event._tag !== "ToolDenied" || event.notOffered === undefined || notOffered === undefined
        ? Effect.succeed(event)
        : Effect.map(notOffered({ tool: event.tool, ...event.notOffered }), (reason) => ({ ...event, reason }));
    yield* activity
      .run(
        {
          prompt: turn.prompt,
          briefing: contextBlock([memory, roster], webMarkBriefing(markedBefore), search.note),
          sessionId: turn.sessionId,
          instructions: systemInstructions(turn.config.name, turn.config),
          instructionsChanged: false,
          model: turn.config.model,
          effort: turn.config.effort,
          tools: turn.access,
          // Settled from the policy as the turn starts, as a chat turn's is (ADR 036).
          webSearch: search.webSearch,
          checkWebSearch: search.checkWebSearch,
          skills,
          approvals,
          redaction: redactor,
          recordToolStart: (event) =>
            turn.recordToolStart(event).pipe(Effect.tap((recorded) => (recorded ? stepOf(event) : Effect.void))),
          // A search's results are found URLs in the Task's session before the hob can act on them, and
          // its session is marked as having read the web (ADR 036).
          recordSearch: (event) =>
            Effect.andThen(
              web.searched({ threadId: null, taskId: turn.taskId }, redactor)(event),
              webMark.read({ _tag: "Search", query: redactor.text(event.query) }),
            ),
          ...(turn.steers === undefined || adapter.steersTurns !== true ? {} : { steers: turn.steers }),
          ...offer,
        },
        adapter.sendPrompt,
      )
      .pipe(
        Stream.tap((event) => webUse.see(redactEvent(event, redactor))),
        Stream.runForEach((event) => {
          if (event._tag === "SkillUsed") return Effect.asVoid(skillUses.record(event));
          if (event._tag === "SessionStarted") {
            const first = session === null;
            session = event.sessionId;
            skillUses.organization(event.organizationSkills);
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
                  Effect.andThen(
                    Effect.suspend(() => {
                      if (roster === null) return Effect.void;
                      rosterMark = startedRoster(roster, expected, event.sessionId);
                      return recordRoster(event.sessionId, rosterMark);
                    }),
                  ),
                ),
            );
          }
          if (event._tag === "Completed") {
            ending = { _tag: "Replied", text: event.text };
            usage = event.usage ?? null;
          }
          return Effect.andThen(confirmBrief, Effect.flatMap(explained(event), stepOf));
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
        Effect.ensuring(Effect.andThen(Effect.andThen(endSteps, endTurn), webUse.end)),
      );
    return ending;
  }).pipe(
    // The end-of-turn compare is recorded as the turn's scope closes, however it ended.
    Effect.scoped,
  );

/** Why a running session was stopped, which decides what its Task becomes. */
export type StopReason = "cancel" | "authority" | "hob" | "interrupt";

export const STOPPED: Record<StopReason, string> = {
  cancel: "Cancelled.",
  authority: "Stopped because its hob's permissions were narrowed.",
  hob: "Stopped by Hobbots before it finished, with its hob's other work.",
  interrupt: "Stopped by its lead's message, which the next turn starts with.",
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
  /**
   * Wakes the session's running turn to take the messages that wait to steer it (#1345), and says
   * whether its runtime can; absent for a session no message steers, such as a step's.
   */
  steering?: { readonly wake: Effect.Effect<void>; readonly steers: boolean } | undefined;
}

/** What the session's hob may do on its Task now: read again for every Charm call (PE-008). */
export const currentAccessOf = (run: Running): Effect.Effect<ToolAccess | null> =>
  run.accessNow ?? Effect.succeed(run.access);
