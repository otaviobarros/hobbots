import { guardMemoryStore, MemoryStore, type MemoryStoreShape } from "@hobbots/agents";
import { MemoryUnavailable } from "@hobbots/domain";
import { Effect, Layer } from "effect";

/**
 * A `MemoryStore` with no engine behind it, for a hub whose memory is off or not connected yet
 * (ADR 028): every call answers that memory is unavailable, so callers treat it as an outage and
 * keep working.
 */
export const makeMemoryStoreOff = (message: string): MemoryStoreShape => {
  const off = Effect.fail(new MemoryUnavailable({ message }));
  return guardMemoryStore({
    search: () => off,
    page: () => off,
    pageAt: () => off,
    scopes: () => off,
    list: () => off,
    changes: () => off,
    history: () => off,
    write: () => off,
    forget: () => off,
    restore: () => off,
    health: off,
  });
};

/** `MemoryStore` with no engine: every call answers that memory is unavailable. */
export const MemoryStoreOff = (message: string) => Layer.succeed(MemoryStore, makeMemoryStoreOff(message));
