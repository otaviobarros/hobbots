import { Effect, PubSub, Stream } from "effect";
import type { AppServer, AppServerCommand, AppServerNotification } from "../src/codex/app-server.ts";
import type { StartAppServer } from "../src/codex/turn.ts";

// A scripted Codex App Server for turn tests: what Hobbots asks it, and what it answers.

export const THREAD = "thr-1";
export const TURN = "turn-1";

/** A notification of the scripted thread's turn. */
export const n = (method: string, params: Record<string, unknown>) =>
  ({ method, params: { threadId: THREAD, turnId: TURN, ...params } }) as AppServerNotification;

export const completedTurn = (turnId: string, status: string, error: unknown = null) =>
  ({
    method: "turn/completed",
    params: { threadId: THREAD, turnId, turn: { id: turnId, items: [], status, error } },
  }) as AppServerNotification;

export const completed = (status: string, error: unknown = null) => completedTurn(TURN, status, error);

/**
 * A scripted App Server: answers the client's requests, and once a turn starts asks `asks` and sends
 * `script`'s notifications. `turn/interrupt` ends the turn as interrupted, as Codex does.
 */
export const fakeServer = (options: {
  readonly script?: ReadonlyArray<AppServerNotification>;
  readonly asks?: ReadonlyArray<{ readonly method: string; readonly params: unknown }>;
  /** The notifications of each later turn the client starts, as `turn-2`, `turn-3` and on. */
  readonly followUps?: ReadonlyArray<ReadonlyArray<AppServerNotification>>;
  /** Ends the process after the script, before any `turn/completed`. */
  readonly dies?: boolean;
  /** Never answers `turn/interrupt`, as a Codex that stopped answering. */
  readonly deaf?: boolean;
  /** What `skills/list` answers: the skills Codex would load (ADR 029). */
  readonly skills?: ReadonlyArray<{
    readonly name: string;
    readonly path: string;
    readonly scope: string;
    readonly enabled: boolean;
  }>;
}) => {
  const requests: Array<{ readonly method: string; readonly params: unknown }> = [];
  // Kept apart, so the turn's own requests read as they always have.
  const skillRequests: Array<{ readonly method: string; readonly params: unknown }> = [];
  const answers: Array<unknown> = [];
  const commands: Array<AppServerCommand> = [];
  let closed = 0;
  const start: StartAppServer = (command, { handlers }) =>
    Effect.gen(function* () {
      commands.push(command);
      let turns = 0;
      const notes = yield* PubSub.unbounded<AppServerNotification | null>();
      yield* Effect.addFinalizer(() => Effect.sync(() => (closed += 1)));
      const ask = (method: string, params: unknown) => {
        const handler = handlers?.[method];
        return handler === undefined
          ? Effect.succeed({ refused: "no handler" })
          : handler(params, method).pipe(Effect.catch((error) => Effect.succeed({ refused: error.message })));
      };
      const run = Effect.gen(function* () {
        for (const { method, params } of options.asks ?? []) answers.push(yield* ask(method, params));
        for (const note of options.script ?? []) yield* PubSub.publish(notes, note);
        if (options.dies) yield* PubSub.publish(notes, null);
      });
      const requestUnknown = (method: string, params: unknown) =>
        Effect.gen(function* () {
          (method.startsWith("skills/") ? skillRequests : requests).push({ method, params });
          switch (method) {
            case "thread/start":
            case "thread/resume":
              return { thread: { id: THREAD }, model: "m" };
            case "turn/start": {
              turns += 1;
              if (turns === 1) {
                yield* Effect.forkDetach(run);
                return { turn: { id: TURN, status: "inProgress", error: null } };
              }
              const later = options.followUps?.[turns - 2] ?? [];
              yield* Effect.forkDetach(Effect.forEach(later, (note) => PubSub.publish(notes, note)));
              return { turn: { id: `turn-${turns}`, status: "inProgress", error: null } };
            }
            case "skills/list":
              return { data: [{ cwd: "", skills: options.skills ?? [], errors: [] }] };
            case "turn/interrupt":
              if (options.deaf) return yield* Effect.never;
              // The acknowledgement names the turn that was interrupted.
              yield* PubSub.publish(notes, completedTurn((params as { turnId: string }).turnId, "interrupted"));
              return {};
            default:
              return {};
          }
        });
      return {
        initialized: {
          userAgent: "codex",
          codexHome: command.env.CODEX_HOME ?? "",
          platformFamily: "unix",
          platformOs: "linux",
        },
        request: requestUnknown as AppServer["request"],
        requestUnknown,
        subscribe: PubSub.subscribe(notes).pipe(
          Effect.map((subscription) =>
            Stream.fromSubscription(subscription).pipe(Stream.takeWhile((note) => note !== null)),
          ),
        ) as AppServer["subscribe"],
        exited: Effect.never,
      } satisfies AppServer;
    });
  return { start, requests, skillRequests, answers, commands, closed: () => closed };
};
