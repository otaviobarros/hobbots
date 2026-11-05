import type { MemoryModelUsage } from "@hobbots/domain";
import { Effect, Redacted, Schema } from "effect";
import { type HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import type { MemoryEndpoint } from "./engine.ts";

/** One workload's counts in the engine's `GET /admin/status`. */
const Workload = Schema.Struct({
  calls: Schema.Number,
  estimated_input_tokens: Schema.Number,
  estimated_output_tokens: Schema.Number,
  reported_input_tokens: Schema.Number,
  reported_output_tokens: Schema.Number,
  usage_reported_calls: Schema.Number,
});

/** The part of the engine's status Hobbots reads: how many pages it keeps, and its model's use. */
const AdminStatus = Schema.Struct({
  counts: Schema.Struct({ pages_latest: Schema.Number }),
  providers: Schema.Struct({
    // Present only while a model is configured.
    llm_workloads: Schema.optionalKey(Schema.Array(Workload)),
    llm_workloads_started_ms: Schema.optionalKey(Schema.NullOr(Schema.Number)),
  }),
});
type AdminStatus = typeof AdminStatus.Type;

/** What Settings and Usage show of a running engine. */
export interface EngineStatus {
  /** The latest version of every page, in every scope. */
  readonly pages: number;
  readonly usage: MemoryModelUsage;
}

/**
 * The model's use from the engine's counts: the tokens its provider reported where it reported
 * them for every call, else the engine's estimate.
 */
export const usageOf = (status: AdminStatus): MemoryModelUsage => {
  const workloads = status.providers.llm_workloads ?? [];
  const sum = (pick: (workload: (typeof workloads)[number]) => number) =>
    workloads.reduce((total, workload) => total + pick(workload), 0);
  const reported = (workload: (typeof workloads)[number]) =>
    workload.calls > 0 && workload.usage_reported_calls === workload.calls;
  const started = status.providers.llm_workloads_started_ms;
  return {
    calls: sum((workload) => workload.calls),
    inputTokens: sum((workload) =>
      reported(workload) ? workload.reported_input_tokens : workload.estimated_input_tokens,
    ),
    outputTokens: sum((workload) =>
      reported(workload) ? workload.reported_output_tokens : workload.estimated_output_tokens,
    ),
    since: typeof started === "number" ? new Date(started).toISOString() : null,
  };
};

/**
 * Reads the engine's status with the root bearer. Null when it does not answer, or answers
 * something Hobbots cannot read: Settings then shows what it last knew.
 */
export const readEngineStatus = (http: HttpClient.HttpClient, endpoint: MemoryEndpoint) =>
  http
    .execute(
      HttpClientRequest.get(`${endpoint.url}/admin/status`).pipe(
        HttpClientRequest.acceptJson,
        HttpClientRequest.bearerToken(Redacted.value(endpoint.root)),
      ),
    )
    .pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap(HttpClientResponse.schemaBodyJson(AdminStatus)),
      Effect.map((status): EngineStatus => ({ pages: status.counts.pages_latest, usage: usageOf(status) })),
      Effect.timeout("3 seconds"),
      Effect.orElseSucceed(() => null),
    );
