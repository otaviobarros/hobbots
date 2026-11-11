import type { MessageId, RuntimeKind, RuntimeSession, TaskBriefMark } from "@hobbots/domain";
import { liveSession, Thread } from "@hobbots/domain";
import { DateTime, Effect, type Option } from "effect";
import { deliveredRoster, rosterAtStart, sameRoster, type TurnRoster } from "./hob-directory.ts";
import { deliveredMemoryBrief, startedMemoryBrief, type TurnMemoryBrief } from "./memory-brief.ts";

const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));

/**
 * `latest` with its session on `runtime` changed by `change`, or null when that session is no longer
 * `sessionId` or `change` leaves it as it is.
 */
const withSession = (
  latest: Thread,
  runtime: RuntimeKind,
  sessionId: string | null,
  updatedAt: string,
  change: (known: RuntimeSession) => RuntimeSession | null,
): Thread | null => {
  const known = latest.sessions.find((s) => s.runtime === runtime);
  const next = known === undefined || known.sessionId !== sessionId ? null : change(known);
  if (next === null) return null;
  return new Thread({ ...latest, sessions: latest.sessions.map((s) => (s === known ? next : s)), updatedAt });
};

/**
 * What a started session keeps of the session the thread knew: what it was told of its Task
 * (#1027) and its read-the-web mark (ADR 036) hold only for the same session.
 */
const carriedMarks = (
  known: RuntimeSession | undefined,
  sessionId: string,
): Pick<RuntimeSession, "taskBrief" | "readWeb"> => {
  if (known?.sessionId !== sessionId) return {};
  return {
    ...(known.taskBrief === undefined ? {} : { taskBrief: known.taskBrief }),
    ...(known.readWeb == null ? {} : { readWeb: known.readWeb }),
  };
};

/** What the turn tells its session ahead of the prompt, once the turn has built it. */
export interface TurnBriefs {
  readonly memory: TurnMemoryBrief | null;
  readonly roster: TurnRoster | null;
}

export interface TurnSessionInput {
  readonly thread: Thread;
  readonly runtime: RuntimeKind;
  readonly changeThread: (
    threadId: Thread["id"],
    change: (thread: Thread) => Thread | null,
  ) => Effect.Effect<Option.Option<Thread>>;
  /** What the turn told its session of the Task it works on (#1027), once the turn knows its Task. */
  readonly toldOfTask: () => TaskBriefMark | null;
}

/**
 * The runtime session one chat turn runs in, as the thread records it: which session the runtime
 * started, the policy its tools ran under, and what the session was told. The thread's session
 * changes only while it is still the one the turn ran in.
 */
export const makeTurnSession = ({ thread, runtime, changeThread, toldOfTask }: TurnSessionInput) => {
  // The session the turn expects to resume, and what it was last told of its Task (#1027): the one
  // in the thread's live chapter, since a session from an earlier chapter is never resumed (ADR 037).
  const expected = liveSession(thread, runtime);
  // The chapter the turn runs in, which the session it starts belongs to, even when a new chapter
  // starts during the turn: the next turn then starts a new session.
  const chapterId = thread.liveChapterId;
  // The session the turn ran in, and the policy version its tools ran under, for the Attempt it may start on a Task.
  let sessionId: string | null = null;
  let policy: string | null = null;
  let briefs: TurnBriefs = { memory: null, roster: null };
  let briefDelivered = false;
  let compacted = false;

  // Changes the thread's session the turn ran in, unless another has taken its place.
  const change = (changeKnown: (known: RuntimeSession) => RuntimeSession | null) =>
    Effect.gen(function* () {
      const updatedAt = yield* nowIso;
      yield* changeThread(thread.id, (latest) => withSession(latest, runtime, sessionId, updatedAt, changeKnown));
    });

  // The brief the turn sent counts as received only once the runtime answers the prompt that
  // carried it: anything it reports after starting the session. A runtime that starts the
  // session and then refuses the prompt leaves it unknown, so the next turn sends it again.
  // So is what the turn told it of its Task (#1027), unless the runtime compacted the session
  // during the turn, which leaves it holding a summary instead: the next turn tells it all.
  const confirmBrief = Effect.suspend(() => {
    const { memory, roster } = briefs;
    const digest = memory === null ? null : deliveredMemoryBrief(memory);
    // A briefing of only what changed reached a session that holds the rest only if it is the
    // one that was told the rest; a new session in its place is told it all next turn.
    const resumedTold = expected?.taskBrief == null || expected.sessionId === sessionId;
    const told = compacted || !resumedTold ? null : toldOfTask();
    const rostered = roster?.sent === true;
    if (briefDelivered || (digest === null && told === null && !rostered) || sessionId === null) return Effect.void;
    briefDelivered = true;
    return change((known) => {
      const next = {
        ...known,
        ...(digest === null ? {} : { memoryBrief: digest }),
        ...(told === null ? {} : { taskBrief: told }),
        ...(roster === null || !rostered
          ? {}
          : {
              roster: deliveredRoster(roster, known.roster ?? { digest: null, readHob: roster.offersReadHob }),
            }),
      };
      return next.memoryBrief === known.memoryBrief &&
        next.taskBrief === known.taskBrief &&
        sameRoster(next.roster, known.roster)
        ? null
        : next;
    });
  });

  // A compacted session keeps a summary of what it was told, not the briefing itself (#1027).
  const forgetTaskBrief = Effect.suspend(() => {
    compacted = true;
    return change((known) => (known.taskBrief == null ? null : { ...known, taskBrief: null }));
  });

  // The session has now seen the thread through `seenThrough`, the turn's reply. It takes the place of
  // the runtime's session in an earlier chapter, which is never resumed again.
  const record = (started: string, seenThrough: MessageId) =>
    Effect.gen(function* () {
      if (chapterId === null) return;
      const { memory, roster } = briefs;
      const updatedAt = yield* nowIso;
      yield* changeThread(thread.id, (latest) => {
        const known = latest.sessions.find((s) => s.runtime === runtime);
        // Without memory, a session keeps whatever brief it was last told of.
        const memoryBrief = memory === null ? known?.memoryBrief : startedMemoryBrief(memory, expected, started);
        const rosterMark = rosterAtStart(roster, known, expected, started);
        const session: RuntimeSession = {
          runtime,
          sessionId: started,
          chapterId,
          seenThrough,
          ...(memoryBrief === undefined ? {} : { memoryBrief }),
          ...carriedMarks(known, started),
          ...(rosterMark === undefined ? {} : { roster: rosterMark }),
        };
        if (
          known?.sessionId === session.sessionId &&
          known.chapterId === chapterId &&
          known.seenThrough === seenThrough &&
          known.memoryBrief === session.memoryBrief &&
          sameRoster(known.roster, session.roster)
        )
          return null;
        const sessions =
          known === undefined
            ? [...latest.sessions, session]
            : latest.sessions.map((s) => (s.runtime === runtime ? session : s));
        return new Thread({ ...latest, sessions, updatedAt });
      });
    });

  return {
    expected,
    /** The session the runtime started for the turn, once it has. */
    id: () => sessionId,
    /** The policy version the turn's tools ran under, once its session started. */
    policy: () => policy,
    /** The runtime started `started` under `policyVersion`. */
    begin: (started: string, policyVersion: string | null) => {
      sessionId = started;
      policy = policyVersion;
    },
    /** What the turn tells its session, once built: confirmed and recorded with the session. */
    briefed: (built: TurnBriefs) => {
      briefs = built;
    },
    change,
    confirmBrief,
    forgetTaskBrief,
    record,
  } as const;
};
