import { guardMemoryStore, type MemoryStoreShape } from "@hobbots/agents";
import { MemoryUnavailable } from "@hobbots/domain";
import { Effect } from "effect";

/**
 * A `MemoryStore` with no engine behind it, for a hub built without memory, as most tests build it
 * (ADR 028): every call answers that memory is unavailable, so callers treat it as an outage and
 * keep working.
 */
export const makeMemoryStoreOff = (message: string): MemoryStoreShape => {
  const off = Effect.fail(new MemoryUnavailable({ message }));
  return guardMemoryStore({
    search: () => off,
    page: () => off,
    versionChanges: () => off,
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
