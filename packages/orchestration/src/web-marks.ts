import type { TaskRepository } from "@hobbots/agents";
import type { Attempt, AttemptId, Committed, WebReadMark } from "@hobbots/domain";
import { Effect, Option } from "effect";

// Where a Task's sessions keep their read-the-web mark: on their Attempts (ADR 036).

/**
 * The read-the-web mark a session holds, from the Attempts of its Task that ran in it (ADR 036): it
 * holds since the first of them read the web, and names what the latest of them read last.
 */
export const markOfSession = (attempts: ReadonlyArray<Attempt>, sessionId: string): WebReadMark | null => {
  const marked = attempts
    .flatMap((attempt) => (attempt.sessionId === sessionId && attempt.readWeb != null ? [attempt] : []))
    .sort((a, b) => a.number - b.number);
  const first = marked[0]?.readWeb;
  const last = marked.at(-1)?.readWeb;
  if (first == null || last == null) return null;
  // ISO times in UTC sort as text.
  const since = marked.map((attempt) => attempt.readWeb?.since ?? first.since).sort()[0] ?? first.since;
  return { since, source: last.source };
};

/** Keeps a read-the-web mark on `attemptId` and announces the change, when there is one (ADR 036). */
export const attemptMarkKeeper =
  (
    tasks: Pick<TaskRepository["Service"], "markAttemptReadWeb">,
    attemptId: AttemptId,
    announce: (committed: Committed<Attempt>) => Effect.Effect<unknown>,
  ) =>
  (mark: WebReadMark): Effect.Effect<void> =>
    tasks
      .markAttemptReadWeb(attemptId, mark)
      .pipe(
        Effect.flatMap(Option.match({ onNone: () => Effect.void, onSome: (kept) => Effect.asVoid(announce(kept)) })),
      );
