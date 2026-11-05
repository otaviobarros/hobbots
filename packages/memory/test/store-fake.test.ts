import { MemoryPath, type MemoryScope, memoryProjectIdentity } from "@hobbots/domain";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { makeMemoryStoreFake } from "../src/store/fake.ts";
import { memoryStoreContract } from "./store-contract.ts";

memoryStoreContract("the fake", () =>
  Effect.sync(() => {
    const { store } = makeMemoryStoreFake();
    // The fake keeps its pages in the process, so a second run sees the same store.
    return { store, reopen: Effect.succeed(store) };
  }),
);

describe("the fake memory", () => {
  // covers ADR 028 (When memory is down)
  it("[TC-GEN-177] answers that memory is unavailable while it is down", () =>
    Effect.gen(function* () {
      const { store, controls } = makeMemoryStoreFake();
      controls.setDown(true);
      expect(yield* Effect.flip(store.health)).toMatchObject({ _tag: "MemoryUnavailable" });
      expect(
        yield* Effect.flip(store.page({ _tag: "You" }, { _tag: "Everyone" }, MemoryPath.make("a.md"))),
      ).toMatchObject({ _tag: "MemoryUnavailable" });
      controls.setDown(false);
      yield* store.health;
    }).pipe(Effect.runPromise));

  // covers ADR 028 (Browse), #958
  it("[TC-GEN-239] lists a project that holds pages, and not one that holds none", () =>
    Effect.gen(function* () {
      const { store } = makeMemoryStoreFake();
      const site: MemoryScope = { _tag: "Project", identity: memoryProjectIdentity(null, "site") };
      const app: MemoryScope = { _tag: "Project", identity: memoryProjectIdentity(null, "app") };
      const you = { _tag: "You" } as const;
      yield* store.write(
        you,
        site,
        { path: MemoryPath.make("facts/a.md"), markdown: "# A", tags: [], pinned: false },
        {
          _tag: "New",
        },
      );
      expect(yield* store.scopes(you)).toEqual([site]);
      expect(yield* store.scopes(you)).not.toContainEqual(app);
    }).pipe(Effect.runPromise));
});
