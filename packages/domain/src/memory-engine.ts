import { Schema } from "effect";

/**
 * The memory engine's process (ADR 028): `starting` until it first answers, `running` while it
 * answers, `restarting` after it exited or stopped answering and is waiting to start again, `off`
 * when it is never started.
 */
export const MemoryEngineState = Schema.Literals(["starting", "running", "restarting", "off"]);
export type MemoryEngineState = typeof MemoryEngineState.Type;

/**
 * Why the engine is off: `disabled` by the hub's settings, `missing` when this copy of Hobbots has no
 * engine binary, `checksum` when the binary is not the one Hobbots was built with.
 */
export const MemoryEngineOffReason = Schema.Literals(["disabled", "missing", "checksum"]);
export type MemoryEngineOffReason = typeof MemoryEngineOffReason.Type;

/** How the engine's process last ended: its exit code, or null when it was stopped by a signal. */
export const MemoryEngineExit = Schema.Struct({
  code: Schema.NullOr(Schema.Number),
  at: Schema.String,
});
export type MemoryEngineExit = typeof MemoryEngineExit.Type;

/**
 * The memory engine's health, as Settings › Diagnostics shows it. It names no path, port or
 * credential, so it can go into a diagnostics report as it is.
 */
export const MemoryEngineHealth = Schema.Struct({
  state: MemoryEngineState,
  /** Set only when the state is `off`. */
  offReason: Schema.NullOr(MemoryEngineOffReason),
  /** The bundled engine's version. */
  version: Schema.String,
  /** How many times the process was started again since the hub started. */
  restarts: Schema.Number,
  lastExit: Schema.NullOr(MemoryEngineExit),
  /** When the process last started answering; null while it does not answer. */
  runningSince: Schema.NullOr(Schema.String),
});
export type MemoryEngineHealth = typeof MemoryEngineHealth.Type;
