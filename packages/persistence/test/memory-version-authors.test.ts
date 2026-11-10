import { MemoryVersionAuthors } from "@hobbots/agents";
import { AgentId, MemoryPath, MemoryVersion, memoryProjectIdentity } from "@hobbots/domain";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { MemoryVersionAuthorsLive } from "../src/index.ts";
import { TestDatabase } from "../src/testing.ts";

// Issue #1317: who wrote each memory version the hub sent, kept by the hub because the engine names
// only the latest version's author, on SQLite and PostgreSQL alike.
describe("Who wrote each memory version", () => {
  const pip = { _tag: "Hob", agentId: AgentId.make("0d6e2f0a-0000-4000-8000-000000000001") } as const;
  const you = { _tag: "You" } as const;
  const app = { _tag: "Project", identity: memoryProjectIdentity("git@github.com:me/app.git", "app") } as const;
  const own = { _tag: "Hob", agentId: pip.agentId } as const;
  const notes = MemoryPath.make("notes/tests.md");
  const version = (id: string) => MemoryVersion.make(id);

  // covers ADR 028 (attribution)
  it("[TC-PE-1317-02] names each recorded version, keeps the first record of one, and forgets a forgotten page's", async () => {
    const many = Array.from({ length: 1_200 }, (_, index) => version(`m${index}`));
    const found = await Effect.gen(function* () {
      const authors = yield* MemoryVersionAuthors;
      yield* authors.record(app, notes, version("v1"), pip);
      yield* authors.record(app, notes, version("v2"), you);
      // A retried write records the same version again.
      yield* authors.record(app, notes, version("v2"), pip);
      yield* authors.record(own, notes, version("v3"), pip);
      yield* Effect.forEach(many, (each) => authors.record(own, MemoryPath.make("notes/many.md"), each, pip), {
        discard: true,
      });
      const before = yield* authors.of([version("v1"), version("v2"), version("v3"), version("unknown")]);
      const all = yield* authors.of(many);
      // Forgetting the app's page leaves the same path in Pip's own memory as it was.
      yield* authors.forget(app, notes);
      const after = yield* authors.of([version("v1"), version("v2"), version("v3")]);
      return { before, all, after, none: yield* authors.of([]) };
    }).pipe(Effect.provide(MemoryVersionAuthorsLive), Effect.provide(TestDatabase), Effect.runPromise);

    expect(found.before).toEqual(
      new Map([
        ["v1", pip],
        ["v2", you],
        ["v3", pip],
      ]),
    );
    expect(found.all.size).toBe(1_200);
    expect(found.after).toEqual(new Map([["v3", pip]]));
    expect(found.none.size).toBe(0);
  });
});
