import { createHash, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { NodeHttpServer } from "@effect/platform-node";
import {
  type PromptRequest,
  type RuntimeAdapterShape,
  type RuntimeAdapters,
  type RuntimeError,
  type RuntimeLimitReached,
  runtimeAdapters,
} from "@hobbots/agents";
import {
  Effort,
  type MemoryModelUsage,
  memoryEffortOn,
  memoryModelOn,
  type ReplyUsage,
  RuntimeKind,
} from "@hobbots/domain";
import { Clock, Context, Effect, Layer, Option, Redacted, Ref, Schema, Semaphore, Stream } from "effect";
import { HttpRouter, HttpServer, type HttpServerRequest, HttpServerResponse } from "effect/http";
import { SMALLEST_MODEL } from "./config.ts";

/**
 * The hub's memory model endpoint (ADR 028): the one way the memory engine reaches a model. It
 * answers the engine's OpenAI-compatible provider on loopback, and runs each request as one turn on
 * the runtime's own adapter, on the sign-in that runtime already has: no tools, no hub tools, no
 * folders and no session to resume or keep. The engine presents the model bearer, a managed
 * credential like the other two.
 */
export interface MemoryModelEndpointShape {
  /** `http://127.0.0.1:<port>`, with no trailing slash. Never shown, logged or given to a hob. */
  readonly url: string;
  /**
   * Whether `runtime`'s plan refused the last memory task for its limit, and when it refills, if
   * the runtime said. A task that runs clears it, and so does the time it named passing.
   */
  readonly limited: (runtime: RuntimeKind) => Effect.Effect<Option.Option<{ readonly resetsAt: string | null }>>;
  /**
   * Runs one of the hub's own turns, such as a judgment (ADR 037), on `runtime` the way a memory
   * task runs: `model` null for its smallest, at `effort` when the model takes it. Its reply, or
   * none when the runtime could not run it or ended without one; a plan's limit is remembered as a
   * memory task's is. The engine never sees these turns, so the endpoint counts them itself.
   */
  readonly ask: (
    runtime: RuntimeKind,
    model: string | null,
    effort: Effort | null,
    text: MemoryTurnText,
  ) => Effect.Effect<Option.Option<string>>;
  /** How much the hub's own turns used since the hub started. */
  readonly hubUsage: Effect.Effect<MemoryModelUsage>;
}

export class MemoryModelEndpoint extends Context.Service<MemoryModelEndpoint, MemoryModelEndpointShape>()(
  "@hobbots/memory/MemoryModelEndpoint",
) {
  /**
   * Serves the endpoint on a free loopback port for as long as the layer's scope is open, running
   * turns on the hub's runtime adapters. `key` is the model bearer from the hub's memory keys.
   */
  static readonly layer = (key: Redacted.Redacted<string>) =>
    Layer.effect(
      MemoryModelEndpoint,
      Effect.gen(function* () {
        const adapters = yield* runtimeAdapters;
        const answer = memoryModelAnswerer(adapters, key);
        const served = yield* Layer.build(
          HttpRouter.serve(HttpRouter.add("POST", COMPLETIONS_PATH, answer.handle), {
            disableLogger: true,
            disableListenLog: true,
          }).pipe(Layer.provideMerge(NodeHttpServer.layer(createServer, { host: "127.0.0.1", port: 0 }))),
        );
        const address = Context.get(served, HttpServer.HttpServer).address;
        if (address._tag !== "InetAddressV4") return yield* Effect.die("The memory model endpoint has no IPv4 address");
        return MemoryModelEndpoint.of({
          url: `http://127.0.0.1:${address.port}`,
          limited: answer.limited,
          ask: answer.ask,
          hubUsage: answer.hubUsage,
        });
      }),
    );
}

/** The engine posts here, under the runtime's base URL: `<url>/<runtime>/v1`. */
const COMPLETIONS_PATH = "/:runtime/v1/chat/completions";

/** How many memory turns run at once: each starts a runtime process, so the engine's bursts queue. */
const CONCURRENT_TURNS = 2;

/** One message of the engine's request, in OpenAI's Chat Completions shape. */
const ChatMessage = Schema.Struct({ role: Schema.String, content: Schema.NullOr(Schema.String) });

/** The part of the engine's request a memory turn reads; the engine's other fields are ignored. */
export const ChatRequest = Schema.Struct({
  model: Schema.String,
  messages: Schema.Array(ChatMessage).check(Schema.isMinLength(1)),
  reasoning_effort: Schema.optionalKey(Schema.NullOr(Schema.String)),
});
export type ChatRequest = typeof ChatRequest.Type;

const decodeRequest = Schema.decodeUnknownEffect(ChatRequest);
const isRuntime = Schema.is(RuntimeKind);
const isEffort = Schema.is(Effort);

/** What a memory turn tells its runtime, from the engine's messages. */
export interface MemoryTurnText {
  /** The system and developer messages, as the turn's instructions. */
  readonly instructions: string;
  /** The rest, as the turn's prompt: one user message as it is, a conversation with each role named. */
  readonly prompt: string;
}

export const memoryTurnText = (messages: ChatRequest["messages"]): MemoryTurnText => {
  const text = (message: (typeof messages)[number]) => message.content ?? "";
  const instructions = messages.filter((message) => message.role === "system" || message.role === "developer");
  const rest = messages.filter((message) => message.role !== "system" && message.role !== "developer");
  const [only] = rest;
  return {
    instructions: instructions.map(text).join("\n\n"),
    prompt:
      rest.length === 1 && only?.role === "user"
        ? text(only)
        : rest.map((message) => `<${message.role}>\n${text(message)}\n</${message.role}>`).join("\n\n"),
  };
};

/**
 * The one turn a memory task runs: no hob's instructions, tools, hub tools, approvals or folders,
 * and no session to resume or keep. Absent tools make the turn chat-only on every adapter.
 */
export const memoryPromptRequest = (
  text: MemoryTurnText,
  model: string | null,
  effort: PromptRequest["effort"],
): PromptRequest => ({
  prompt: text.prompt,
  instructions: text.instructions,
  instructionsChanged: false,
  sessionId: null,
  model,
  effort,
  tools: null,
  approvals: null,
  hubTools: null,
  ephemeral: true,
});

/** An error the engine reads as OpenAI's: `429` and `5xx` are transient, so its fallback chain applies. */
const failure = (status: number, type: string, message: string, headers: Record<string, string> = {}) =>
  HttpServerResponse.jsonUnsafe({ error: { type, message } }, { status, headers: { ...headers, ...NO_STORE } });

const NO_STORE = { "Cache-Control": "no-store" };

const digest = (value: string) => createHash("sha256").update(value).digest();

/** Whether the request carries the model bearer, compared in constant time. */
const authorized = (request: HttpServerRequest.HttpServerRequest, key: Redacted.Redacted<string>) => {
  const header = request.headers.authorization ?? "";
  return timingSafeEqual(digest(header), digest(`Bearer ${Redacted.value(key)}`));
};

/** Seconds until `resetsAt`, for `Retry-After`, or nothing when it is unknown or past. */
const retryAfter = (resetsAt: string | null, now: number): Record<string, string> => {
  const at = resetsAt === null ? Number.NaN : Date.parse(resetsAt);
  return Number.isFinite(at) && at > now ? { "Retry-After": String(Math.ceil((at - now) / 1000)) } : {};
};

/** The model and effort a turn asks for: null for the runtime's smallest, and for no effort chosen. */
interface AskedModel {
  readonly model: string | null;
  readonly effort: Effort | null;
}

/** What a finished turn said, and what it used when the runtime reports it. */
interface TurnReply {
  readonly text: string;
  readonly usage: ReplyUsage | undefined;
}

const runTurn = (adapter: RuntimeAdapterShape, request: PromptRequest) =>
  adapter.sendPrompt(request).pipe(
    Stream.runFold(
      (): TurnReply | null => null,
      (reply, event) => (event._tag === "Completed" ? { text: event.text, usage: event.usage } : reply),
    ),
  );

/** The engine's request answered in OpenAI's Chat Completions shape. */
const completion = (model: string, reply: TurnReply, created: number) => {
  const input = reply.usage?.inputTokens ?? null;
  const output = reply.usage?.outputTokens ?? null;
  return {
    id: `hobbots-memory-${created}`,
    object: "chat.completion",
    created: Math.floor(created / 1000),
    model,
    choices: [{ index: 0, message: { role: "assistant", content: reply.text }, finish_reason: "stop" }],
    ...(input === null || output === null
      ? {}
      : { usage: { prompt_tokens: input, completion_tokens: output, total_tokens: input + output } }),
  };
};

/**
 * Answers the engine's requests on the runtimes' adapters, and remembers which runtime's plan last
 * refused a task for its limit. Exposed for tests, which call `handle` without a server.
 */
export const memoryModelAnswerer = (adapters: RuntimeAdapters, key: Redacted.Redacted<string>) => {
  const limits = Ref.makeUnsafe(new Map<RuntimeKind, string | null>());
  const turns = Semaphore.makeUnsafe(CONCURRENT_TURNS);

  const limited = (runtime: RuntimeKind) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const known = (yield* Ref.get(limits)).get(runtime);
      if (known === undefined) return Option.none();
      if (known !== null && Date.parse(known) <= now) return Option.none();
      return Option.some({ resetsAt: known });
    });

  const setLimit = (runtime: RuntimeKind, resetsAt: string | null | undefined) =>
    Ref.update(limits, (current) => {
      const next = new Map(current);
      if (resetsAt === undefined) next.delete(runtime);
      else next.set(runtime, resetsAt);
      return next;
    });

  /**
   * One turn on the runtime's adapter, on the model asked for while it offers it, else its
   * smallest, at an effort the model takes. A plan's limit is remembered, and a turn that runs
   * clears it.
   */
  const turn = (adapter: RuntimeAdapterShape, runtime: RuntimeKind, asked: AskedModel, text: MemoryTurnText) =>
    Effect.gen(function* () {
      const listed = yield* adapter.models;
      const { model } = memoryModelOn(listed, asked.model);
      const effort = memoryEffortOn(model, asked.effort);
      const request = memoryPromptRequest(text, model?.id ?? null, effort);
      const reply = yield* turns.withPermit(runTurn(adapter, request));
      if (reply !== null) yield* setLimit(runtime, undefined);
      return { model: model?.id ?? null, reply };
    }).pipe(
      Effect.tapError((error) =>
        error._tag === "RuntimeLimitReached" ? setLimit(runtime, error.resetsAt) : Effect.void,
      ),
    );

  const run = (runtime: RuntimeKind, adapter: RuntimeAdapterShape, request: ChatRequest) =>
    Effect.gen(function* () {
      const asked = request.reasoning_effort ?? null;
      const { model, reply } = yield* turn(
        adapter,
        runtime,
        { model: request.model === SMALLEST_MODEL ? null : request.model, effort: isEffort(asked) ? asked : null },
        memoryTurnText(request.messages),
      );
      const now = yield* Clock.currentTimeMillis;
      if (reply === null) return failure(502, "server_error", "The runtime ended the turn without a reply.");
      return HttpServerResponse.jsonUnsafe(completion(model ?? request.model, reply, now), { headers: NO_STORE });
    }).pipe(
      Effect.catchTags({
        RuntimeLimitReached: (limit: RuntimeLimitReached) =>
          Effect.gen(function* () {
            const now = yield* Clock.currentTimeMillis;
            return failure(
              429,
              "rate_limit_error",
              "The plan's usage limit was reached.",
              retryAfter(limit.resetsAt, now),
            );
          }),
        // A runtime that is signed out, missing or failing: transient for the engine, so the
        // fallback applies, and tried again on the next task.
        RuntimeError: (error: RuntimeError) =>
          Effect.logWarning(`A memory task could not run: ${error.message}`).pipe(
            Effect.as(failure(503, "server_error", "The runtime could not run the memory task.")),
          ),
      }),
    );

  const usage = Ref.makeUnsafe<MemoryModelUsage>({ calls: 0, inputTokens: 0, outputTokens: 0, since: null });

  const count = (reply: TurnReply) =>
    Effect.flatMap(Clock.currentTimeMillis, (now) =>
      Ref.update(usage, (used) => ({
        calls: used.calls + 1,
        inputTokens: used.inputTokens + (reply.usage?.inputTokens ?? 0),
        outputTokens: used.outputTokens + (reply.usage?.outputTokens ?? 0),
        since: used.since ?? new Date(now).toISOString(),
      })),
    );

  const ask = (runtime: RuntimeKind, model: string | null, effort: Effort | null, text: MemoryTurnText) => {
    const adapter = adapters(runtime);
    if (adapter === undefined) return Effect.succeed(Option.none<string>());
    return turn(adapter, runtime, { model, effort }, text).pipe(
      Effect.flatMap(({ reply }) =>
        reply === null ? Effect.succeed(Option.none<string>()) : Effect.as(count(reply), Option.some(reply.text)),
      ),
      Effect.catchTags({
        RuntimeLimitReached: () => Effect.succeed(Option.none<string>()),
        RuntimeError: (error: RuntimeError) =>
          Effect.logWarning(`A hub turn could not run: ${error.message}`).pipe(Effect.as(Option.none<string>())),
      }),
    );
  };

  const handle = (request: HttpServerRequest.HttpServerRequest) =>
    Effect.gen(function* () {
      if (!authorized(request, key)) return failure(401, "authentication_error", "Not authorized.");
      const runtime = (yield* HttpRouter.params).runtime;
      const adapter = isRuntime(runtime) ? adapters(runtime) : undefined;
      if (!isRuntime(runtime) || adapter === undefined) return failure(404, "not_found_error", "No such runtime.");
      const body = yield* request.json.pipe(Effect.flatMap(decodeRequest), Effect.option);
      if (Option.isNone(body)) return failure(400, "invalid_request_error", "The request is not one Hobbots reads.");
      return yield* run(runtime, adapter, body.value);
    });

  return { handle, limited, ask, hubUsage: Ref.get(usage) };
};
