import { MemoryUnavailable } from "@hobbots/domain";
import { Data, Effect, Option, Redacted, Schema } from "effect";
import { HttpClient, HttpClientRequest, type HttpClientResponse } from "effect/http";
import type { MemoryEndpoint } from "../engine/engine.ts";
import { MemoryEngine } from "../engine/engine.ts";

/**
 * A small typed client for the ai-memory routes `MemoryStore` uses (ADR 028): `/mcp` tools as a hob
 * or as you, and `/api/v1` and `/admin` as you. Every answer is decoded with `Schema`. It knows the
 * engine's routes and errors, and nothing about Hobbots' scopes.
 */

/** Who a request goes as: a hob, asserted through the proxy bearer, or you, with the root bearer. */
export type EngineCaller = { readonly as: "root" } | { readonly as: "hob"; readonly name: string };

export const ROOT: EngineCaller = { as: "root" };

/** A refusal the engine explained: the JSON-RPC error of a tool, or an HTTP status with its body. */
export class EngineRefused extends Data.TaggedError("EngineRefused")<{
  readonly status: number;
  readonly message: string;
  readonly data: unknown;
}> {}

const unavailable = (message: string) => new MemoryUnavailable({ message });

const RpcAnswer = Schema.Struct({
  result: Schema.optionalKey(
    Schema.Struct({
      content: Schema.Array(Schema.Struct({ text: Schema.String })),
      isError: Schema.optionalKey(Schema.Boolean),
    }),
  ),
  error: Schema.optionalKey(
    Schema.Struct({ code: Schema.Number, message: Schema.String, data: Schema.optionalKey(Schema.Unknown) }),
  ),
});
const ErrorBody = Schema.Struct({ error: Schema.String });

/** Whether a refusal says the scope's project does not exist yet: an empty scope, not a failure. */
export const noSuchProject = (refused: EngineRefused) =>
  refused.status === 404 || /(?:project|workspace) '[^']*' not found/.test(refused.message);

export const makeEngineClient = Effect.gen(function* () {
  const engine = yield* MemoryEngine;
  const http = yield* HttpClient.HttpClient;
  let rpcId = 0;

  const endpoint = Effect.flatMap(engine.endpoint, (found) =>
    Option.match(found, {
      onNone: () => Effect.fail(unavailable("Memory is not running.")),
      onSome: (value: MemoryEndpoint) => Effect.succeed(value),
    }),
  );

  const authorize = (point: MemoryEndpoint, caller: EngineCaller) =>
    caller.as === "root"
      ? HttpClientRequest.bearerToken(Redacted.value(point.root))
      : (request: HttpClientRequest.HttpClientRequest) =>
          request.pipe(
            HttpClientRequest.bearerToken(Redacted.value(point.proxy)),
            HttpClientRequest.setHeaders({ "X-Memory-Actor-User": caller.name }),
          );

  const send = (caller: EngineCaller, build: (url: string) => HttpClientRequest.HttpClientRequest) =>
    Effect.gen(function* () {
      const point = yield* endpoint;
      return yield* http.execute(build(point.url).pipe(authorize(point, caller))).pipe(
        Effect.timeout("20 seconds"),
        Effect.mapError(() => unavailable("Memory did not answer.")),
      );
    });

  const decode = <S extends Schema.ConstraintDecoder<unknown>>(
    response: HttpClientResponse.HttpClientResponse,
    schema: S,
  ) =>
    response.json.pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(schema)),
      Effect.mapError(() => unavailable("Memory answered in a form Hobbots does not read.")),
    ) as Effect.Effect<S["Type"], MemoryUnavailable>;

  const answer = <S extends Schema.ConstraintDecoder<unknown>>(
    response: HttpClientResponse.HttpClientResponse,
    schema: S,
  ) =>
    Effect.gen(function* () {
      if (response.status >= 500) return yield* unavailable(`Memory failed (${response.status}).`);
      if (response.status >= 400) {
        const body = yield* decode(response, ErrorBody).pipe(Effect.orElseSucceed(() => ({ error: "" })));
        return yield* new EngineRefused({ status: response.status, message: body.error, data: null });
      }
      return yield* decode(response, schema);
    });

  return {
    /** Reads `/api/v1/<path>` as you. */
    get: <S extends Schema.ConstraintDecoder<unknown>>(path: string, schema: S, params: Record<string, string> = {}) =>
      Effect.flatMap(
        send(ROOT, (url) =>
          HttpClientRequest.get(`${url}/api/v1/${path}`, { urlParams: params }).pipe(HttpClientRequest.acceptJson),
        ),
        (response) => answer(response, schema),
      ),
    /** Posts to `/admin/<path>` as you. */
    admin: <S extends Schema.ConstraintDecoder<unknown>>(path: string, body: unknown, schema: S) =>
      Effect.flatMap(
        send(ROOT, (url) =>
          HttpClientRequest.post(`${url}/admin/${path}`).pipe(
            HttpClientRequest.acceptJson,
            HttpClientRequest.bodyJsonUnsafe(body),
          ),
        ),
        (response) => answer(response, schema),
      ),
    /** Calls an MCP tool as `caller`, with the stateless transport, and decodes the JSON it answers. */
    tool: <S extends Schema.ConstraintDecoder<unknown>>(
      caller: EngineCaller,
      name: string,
      args: Record<string, unknown>,
      schema: S,
    ) =>
      Effect.gen(function* () {
        rpcId += 1;
        const response = yield* send(caller, (url) =>
          HttpClientRequest.post(`${url}/mcp`).pipe(
            HttpClientRequest.setHeaders({ Accept: "application/json, text/event-stream" }),
            HttpClientRequest.bodyJsonUnsafe({
              jsonrpc: "2.0",
              id: rpcId,
              method: "tools/call",
              params: { name, arguments: args },
            }),
          ),
        );
        const rpc = yield* answer(response, RpcAnswer);
        if (rpc.error !== undefined) {
          return yield* new EngineRefused({ status: 200, message: rpc.error.message, data: rpc.error.data ?? null });
        }
        const text = rpc.result?.content[0]?.text ?? "null";
        if (rpc.result?.isError === true) return yield* new EngineRefused({ status: 200, message: text, data: null });
        return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(text).pipe(
          Effect.mapError(() => unavailable(`Memory answered ${name} in a form Hobbots does not read.`)),
        ) as Effect.Effect<S["Type"], MemoryUnavailable>;
      }),
    /** Succeeds while the engine answers its health check. */
    health: Effect.flatMap(
      send(ROOT, (url) => HttpClientRequest.get(`${url}/healthz`)),
      (response) => (response.status === 200 ? Effect.void : Effect.fail(unavailable("Memory is not healthy."))),
    ),
  };
});

export type EngineClient = Effect.Success<typeof makeEngineClient>;
