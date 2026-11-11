import { MemoryEngineHealth, MemoryModelState, MemoryModelUsage, MemorySettings } from "@hobbots/domain";
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api";
import { DeviceSession } from "./user-session.ts";

/**
 * Settings › Your data › Memory (ADR 028): the memory engine's state, what it keeps, and the
 * memory model you chose, with what memory runs with now. The engine's address, port and keys are
 * never part of it.
 */
export const MemoryOverview = Schema.Struct({
  settings: MemorySettings,
  state: MemoryModelState,
  /** Null on a hub built without a memory engine. */
  engine: Schema.NullOr(MemoryEngineHealth),
  /** How many pages your hobs remember; null while the engine does not answer. */
  pages: Schema.NullOr(Schema.Number),
  /** The size of the memory folder on the hub, in bytes; null until it has one. */
  bytes: Schema.NullOr(Schema.Number),
  /** The memory model's use since the engine last started; null while the engine does not answer. */
  usage: Schema.NullOr(MemoryModelUsage),
  /**
   * The hub's brain's own turns since the hub started (ADR 037), such as its judgments, which the
   * engine never sees; null on a hub without the model endpoint.
   */
  hubUsage: Schema.NullOr(MemoryModelUsage),
});
export type MemoryOverview = typeof MemoryOverview.Type;

export class MemoryGroup extends HttpApiGroup.make("memory")
  .add(
    HttpApiEndpoint.get("overview", "/memory", { success: MemoryOverview }),
    // A changed model restarts only the memory engine's process, never the hub (ADR 028).
    HttpApiEndpoint.put("settings", "/memory/settings", { payload: MemorySettings, success: MemoryOverview }),
  )
  .middleware(DeviceSession)
  .prefix("/api") {}
