import { makeMemoryChangeWatch, memoryScopeCounts } from "@hobbots/agents";
import { AgentId, type MemoryActor, MemoryPath, type MemoryScope } from "@hobbots/domain";
import { Duration, Effect } from "effect";
import { describe, expect, it } from "vitest";
import { makeMemoryStoreFake } from "../src/store/fake.ts";

const pip = AgentId.make("0d6e2f0a-0000-4000-8000-000000000011");
const asPip: MemoryActor = { _tag: "Hob", agentId: pip, projects: [] };
const pipsOwn: MemoryScope = { _tag: "Hob", agentId: pip };
const everyone: MemoryScope = { _tag: "Everyone" };
const you: MemoryActor = { _tag: "You" };
const fresh = { _tag: "New" } as const;

const draft = (path: string, markdown: string) => ({ path: MemoryPath.make(path), markdown, tags: [], pinned: false });

describe("the Memory page's reads", () => {
  // covers ADR 028 (Browse), #958
  it("[TC-GEN-232] counts the pages of every scope that holds one", () =>
    Effect.gen(function* () {
      const { store } = makeMemoryStoreFake();
      expect(yield* memoryScopeCounts(store)).toEqual([]);
      yield* store.write(asPip, pipsOwn, draft("howtos/a.md", "# A"), fresh);
      yield* store.write(asPip, pipsOwn, draft("gotchas/b.md", "# B"), fresh);
      yield* store.write(you, everyone, draft("rules/c.md", "# C"), fresh);
      const counts = yield* memoryScopeCounts(store);
      expect(counts).toHaveLength(2);
      expect(counts).toContainEqual({ scope: pipsOwn, pages: 2 });
      expect(counts).toContainEqual({ scope: everyone, pages: 1 });
    }).pipe(Effect.runPromise));

  // covers ADR 028 (What changed), #958
  it("[TC-GEN-233] finds each saved version once, with who saved it, newest first", () =>
    Effect.gen(function* () {
      const { store } = makeMemoryStoreFake();
      yield* store.write(asPip, pipsOwn, draft("howtos/preview.md", "# Publishing a preview link"), fresh);
      const watch = yield* makeMemoryChangeWatch(store);
      // The first read looks back, so What changed opens with what was saved before the hub asked.
      const first = yield* watch.recent;
      expect(first).toEqual([
        expect.objectContaining({
          scope: pipsOwn,
          path: "howtos/preview.md",
          title: "Publishing a preview link",
          author: { _tag: "Hob", agentId: pip },
        }),
      ]);
      // Nothing new since: the next look finds nothing, and what was found stays.
      expect(yield* watch.look).toEqual([]);
      yield* store.write(
        asPip,
        pipsOwn,
        draft("howtos/preview.md", "# Publishing a preview link\n\nLinks last 7 days."),
        { _tag: "Version", version: first[0]?.version as never },
      );
      yield* store.write(you, everyone, draft("rules/ask.md", "# Ask before emailing"), fresh);
      const next = yield* watch.look;
      expect(next.map((change) => change.title).sort()).toEqual(["Ask before emailing", "Publishing a preview link"]);
      const recent = yield* watch.recent;
      expect(recent).toHaveLength(3);
      expect(recent.map((change) => change.at)).toEqual([...recent.map((change) => change.at)].sort().reverse());
      expect(recent.find((change) => change.path === "rules/ask.md")?.author).toEqual({ _tag: "You" });
    }).pipe(Effect.runPromise));

  // covers ADR 028 (What changed), #958
  it("[TC-GEN-234] keeps only the newest changes, and fails while memory is down", () =>
    Effect.gen(function* () {
      const { store, controls } = makeMemoryStoreFake();
      const watch = yield* makeMemoryChangeWatch(store, { lookback: Duration.days(1), keep: 2 });
      for (const name of ["a", "b", "c"])
        yield* store.write(asPip, pipsOwn, draft(`facts/${name}.md`, `# ${name}`), fresh);
      expect(yield* watch.recent).toHaveLength(2);
      controls.setDown(true);
      expect(yield* Effect.flip(watch.look)).toMatchObject({ _tag: "MemoryUnavailable" });
      controls.setDown(false);
      expect(yield* watch.look).toEqual([]);
    }).pipe(Effect.runPromise));
});
