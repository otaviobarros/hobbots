import { Deferred, Effect, PubSub, Queue, Schema, type Scope, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import type { ClientRequests, InitializeResponse, JsonRpcMessage, RequestId } from "./protocol.ts";

/** The App Server did not answer, answered with an error, or exited. */
export class AppServerError extends Schema.TaggedError<AppServerError>()("AppServerError", {
  message: Schema.String,
  /** The JSON-RPC error code, when Codex answered a request with an error. */
  code: Schema.optional(Schema.Number),
}) {}

/**
 * How to start `codex app-server`. The command and its arguments are given whole, so a turn can
 * wrap Codex in Hobbots' sandbox (ADR 014). The environment is the whole environment Codex gets.
 */
export interface AppServerCommand {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly env: Readonly<Record<string, string>>;
  readonly cwd?: string | undefined;
}

/** A notification from the App Server, such as `turn/completed`. */
export interface AppServerNotification {
  readonly method: string;
  readonly params: unknown;
}

/**
 * Answers the App Server's requests to the client, such as approvals, by method. The result is
 * sent as the response; a failure is sent as an error. A method without a handler is refused.
 */
export type ServerRequestHandlers = Readonly<
  Record<string, (params: unknown, id: RequestId) => Effect.Effect<unknown, AppServerError>>
>;

export interface AppServer {
  /** What `initialize` answered. */
  readonly initialized: InitializeResponse;
  /** Sends a request and waits for its result. */
  readonly request: <M extends keyof ClientRequests>(
    method: M,
    params: ClientRequests[M]["params"],
  ) => Effect.Effect<ClientRequests[M]["result"], AppServerError>;
  /** Sends a request this module has no types for yet, for methods added after the probe. */
  readonly requestUnknown: (method: string, params: unknown) => Effect.Effect<unknown, AppServerError>;
  /** Notifications that arrive after the stream is run; earlier ones are not kept. */
  readonly notifications: Stream.Stream<AppServerNotification>;
  /** Succeeds with the exit code when the process exits, for whatever reason. */
  readonly exited: Effect.Effect<number>;
}

export interface AppServerOptions {
  readonly handlers?: ServerRequestHandlers | undefined;
  /** Hobbots' version, which Codex adds to its user agent. */
  readonly clientVersion: string;
}

/** JSON-RPC's code for a method the receiver does not know. */
const METHOD_NOT_FOUND = -32601;
const INTERNAL_ERROR = -32603;

const parse = (line: string): JsonRpcMessage | undefined => {
  try {
    const message: unknown = JSON.parse(line);
    return typeof message === "object" && message !== null ? (message as JsonRpcMessage) : undefined;
  } catch {
    return undefined;
  }
};

/**
 * Starts `codex app-server` over stdio and initializes it with the experimental API (ADR 024).
 * The process lives as long as the scope: closing the scope ends it and everything it started.
 */
export const startAppServer = (
  command: AppServerCommand,
  options: AppServerOptions,
): Effect.Effect<AppServer, AppServerError, Scope.Scope | ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const outbox = yield* Queue.unbounded<string>();
    const handle = yield* spawner
      .spawn(
        ChildProcess.make(command.command, [...command.args], {
          env: { ...command.env },
          extendEnv: false,
          ...(command.cwd ? { cwd: command.cwd } : {}),
          stdin: Stream.fromQueue(outbox).pipe(
            Stream.map((line) => `${line}\n`),
            Stream.encodeText,
          ),
          forceKillAfter: "2 seconds",
        }),
      )
      .pipe(
        Effect.mapError((error) => new AppServerError({ message: `Codex could not be started: ${error.message}` })),
      );

    const send = (message: JsonRpcMessage) => Queue.offer(outbox, JSON.stringify(message));
    const pending = new Map<RequestId, Deferred.Deferred<unknown, AppServerError>>();
    const notifications = yield* PubSub.unbounded<AppServerNotification>();
    const exit = yield* Deferred.make<number>();
    let nextId = 0;

    const answer = (id: RequestId, method: string, params: unknown) => {
      const handler = options.handlers?.[method];
      if (handler === undefined) {
        return send({ id, error: { code: METHOD_NOT_FOUND, message: `Hobbots does not answer ${method}.` } });
      }
      return handler(params, id).pipe(
        Effect.matchEffect({
          onSuccess: (result) => send({ id, result }),
          onFailure: (error) => send({ id, error: { code: error.code ?? INTERNAL_ERROR, message: error.message } }),
        }),
      );
    };

    const receive = (message: JsonRpcMessage) => {
      if (message.method !== undefined && message.id !== undefined) {
        return Effect.forkScoped(answer(message.id, message.method, message.params)).pipe(Effect.asVoid);
      }
      if (message.method !== undefined) {
        return PubSub.publish(notifications, { method: message.method, params: message.params }).pipe(Effect.asVoid);
      }
      if (message.id === undefined) return Effect.void;
      const waiting = pending.get(message.id);
      if (waiting === undefined) return Effect.void;
      pending.delete(message.id);
      return message.error
        ? Deferred.fail(waiting, new AppServerError({ message: message.error.message, code: message.error.code })).pipe(
            Effect.asVoid,
          )
        : Deferred.succeed(waiting, message.result).pipe(Effect.asVoid);
    };

    // Codex writes one JSON message per line; anything else on stdout is ignored.
    yield* handle.stdout.pipe(
      Stream.decodeText,
      Stream.splitLines,
      Stream.runForEach((line) => {
        const message = parse(line);
        return message === undefined ? Effect.void : receive(message);
      }),
      Effect.ignore,
      Effect.andThen(handle.exitCode.pipe(Effect.orElseSucceed(() => -1))),
      Effect.flatMap((code) =>
        Effect.gen(function* () {
          yield* Deferred.succeed(exit, Number(code));
          const gone = new AppServerError({ message: `Codex exited with code ${code} before it answered.` });
          for (const waiting of pending.values()) yield* Deferred.fail(waiting, gone);
          pending.clear();
        }),
      ),
      Effect.forkScoped,
    );
    // Codex logs to stderr; it is read so the pipe never fills and blocks it.
    yield* handle.stderr.pipe(Stream.runDrain, Effect.ignore, Effect.forkScoped);

    const requestUnknown = (method: string, params: unknown) =>
      Effect.gen(function* () {
        if (yield* Deferred.isDone(exit)) {
          return yield* new AppServerError({ message: `Codex exited before ${method} was sent.` });
        }
        const id = ++nextId;
        const waiting = yield* Deferred.make<unknown, AppServerError>();
        pending.set(id, waiting);
        yield* send({ id, method, params });
        return yield* Deferred.await(waiting).pipe(Effect.onInterrupt(() => Effect.sync(() => pending.delete(id))));
      });
    const request = <M extends keyof ClientRequests>(method: M, params: ClientRequests[M]["params"]) =>
      requestUnknown(method, params) as Effect.Effect<ClientRequests[M]["result"], AppServerError>;

    const initialized = yield* request("initialize", {
      clientInfo: { name: "hobbots", title: "Hobbots", version: options.clientVersion },
      capabilities: { experimentalApi: true },
    });
    yield* send({ method: "initialized" });

    return {
      initialized,
      request,
      requestUnknown,
      notifications: Stream.fromPubSub(notifications),
      exited: Deferred.await(exit),
    } satisfies AppServer;
  });
