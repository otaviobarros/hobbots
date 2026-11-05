import type { MemoryStoreShape } from "@hobbots/agents";
import {
  AgentId,
  type MemoryActor,
  MemoryConflict,
  type MemoryDraft,
  MemoryPath,
  type MemoryScope,
  type MemoryVersion,
  memoryProjectIdentity,
} from "@hobbots/domain";
import { Cause, Effect, Exit } from "effect";
import { describe, expect, it } from "vitest";

/**
 * The tests every `MemoryStore` passes, the fake and ai-memory alike (ADR 028), so a caller tested on
 * the fake can trust the engine. `open` opens the memory under test; `reopen` opens the same memory
 * again, as the hub does on its next start.
 */
export interface MemoryUnderTest {
  readonly store: MemoryStoreShape;
  readonly reopen: Effect.Effect<MemoryStoreShape>;
}

const pip = AgentId.make("0d6e2f0a-0000-4000-8000-000000000001");
const quill = AgentId.make("0d6e2f0a-0000-4000-8000-000000000002");
const app = memoryProjectIdentity("git@github.com:me/app.git", "app");
const site = memoryProjectIdentity("git@github.com:me/site.git", "site");
// The hub works out what a hob reaches from its folders: Pip works in the app, Quill in the site.
const asPip: MemoryActor = { _tag: "Hob", agentId: pip, projects: [app] };
const asQuill: MemoryActor = { _tag: "Hob", agentId: quill, projects: [site] };
const you: MemoryActor = { _tag: "You" };
const byPip = { _tag: "Hob", agentId: pip } as const;
const pipsOwn: MemoryScope = { _tag: "Hob", agentId: pip };
const quillsOwn: MemoryScope = { _tag: "Hob", agentId: quill };
const theApp: MemoryScope = { _tag: "Project", identity: app };
const theSite: MemoryScope = { _tag: "Project", identity: site };
const everyone: MemoryScope = { _tag: "Everyone" };
const any = { _tag: "Any" } as const;
const fresh = { _tag: "New" } as const;

const draft = (path: string, markdown: string, more: Partial<MemoryDraft> = {}): MemoryDraft => ({
  path: MemoryPath.make(path),
  markdown,
  tags: [],
  pinned: false,
  ...more,
});

/** Whether `effect` died, as a call refused by the guard does. */
const died = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.map(Effect.exit(effect), (exit) => Exit.isFailure(exit) && Cause.hasDies(exit.cause));

export const memoryStoreContract = (name: string, open: () => Effect.Effect<MemoryUnderTest>) => {
  const run = <A>(body: (memory: MemoryUnderTest) => Effect.Effect<A, unknown>) =>
    Effect.runPromise(Effect.flatMap(open(), body) as Effect.Effect<A>);

  describe(`MemoryStore contract: ${name}`, () => {
    // covers ADR 028 (The MemoryStore service)
    it("[TC-GEN-170] starts empty and answers on its first run", () =>
      run(({ store }) =>
        Effect.gen(function* () {
          yield* store.health;
          expect(yield* store.list(asPip, pipsOwn, 50)).toEqual([]);
          expect(yield* store.page(asPip, pipsOwn, MemoryPath.make("notes/tests.md"))).toBeNull();
          expect(yield* store.search(asPip, [pipsOwn, theApp, everyone], "tests", 10)).toEqual([]);
          expect(yield* store.history(you, everyone, MemoryPath.make("notes/tests.md"))).toEqual([]);
        }),
      ));

    // covers ADR 028 (attribution), #954
    it("[TC-GEN-171] keeps a hob's page, attributed to it, across a second run", () =>
      run(({ store, reopen }) =>
        Effect.gen(function* () {
          const path = MemoryPath.make("notes/tests.md");
          const first = yield* store.write(
            asPip,
            pipsOwn,
            draft("notes/tests.md", "# Tests\n\nRun pnpm check."),
            fresh,
          );
          const again = yield* reopen;
          const page = yield* again.page(asPip, pipsOwn, path);
          expect(page).toMatchObject({
            scope: pipsOwn,
            path,
            markdown: "# Tests\n\nRun pnpm check.",
            version: first,
            author: byPip,
            pinned: false,
          });
          const second = yield* again.write(
            you,
            pipsOwn,
            draft("notes/tests.md", "# Tests\n\nRun pnpm check, then pnpm test:pg.", { tags: ["repo"] }),
            { _tag: "Version", version: first },
          );
          expect(second).not.toEqual(first);
          expect(yield* again.page(asPip, pipsOwn, path)).toMatchObject({
            version: second,
            author: you,
            tags: ["repo"],
          });
          const history = yield* again.history(asPip, pipsOwn, path);
          expect(history.map(({ version, latest }) => ({ version, latest }))).toEqual([
            { version: second, latest: true },
            { version: first, latest: false },
          ]);
          expect(history[0]?.author).toEqual({ _tag: "You" });
          // An engine may know who wrote only the latest version.
          expect([null, byPip]).toContainEqual(history[1]?.author);
        }),
      ));

    // covers ADR 028 (MemoryConflict)
    it("[TC-GEN-172] refuses a write that would overwrite a version it did not see", () =>
      run(({ store }) =>
        Effect.gen(function* () {
          const first = yield* store.write(asPip, pipsOwn, draft("notes/pr.md", "# PRs\n\nSmall."), fresh);
          const second = yield* store.write(asPip, pipsOwn, draft("notes/pr.md", "# PRs\n\nSmall, one topic."), any);
          const stale = yield* Effect.flip(
            store.write(asPip, pipsOwn, draft("notes/pr.md", "# PRs\n\nBig."), { _tag: "Version", version: first }),
          );
          expect(stale).toEqual(new MemoryConflict({ path: MemoryPath.make("notes/pr.md"), current: second }));
          const taken = yield* Effect.flip(store.write(asPip, pipsOwn, draft("notes/pr.md", "# PRs"), fresh));
          expect(taken).toMatchObject({ _tag: "MemoryConflict", current: second });
          expect(yield* store.page(asPip, pipsOwn, MemoryPath.make("notes/pr.md"))).toMatchObject({ version: second });
        }),
      ));

    // covers ADR 028 (memory_search scopes)
    it("[TC-GEN-173] searches only the scopes it is given", () =>
      run(({ store }) =>
        Effect.gen(function* () {
          yield* store.write(asPip, pipsOwn, draft("notes/deploy.md", "# Deploy\n\nPip deploys with fly."), fresh);
          yield* store.write(asQuill, quillsOwn, draft("notes/deploy.md", "# Deploy\n\nQuill deploys by hand."), fresh);
          yield* store.write(asPip, theApp, draft("facts/deploy.md", "# Deploy\n\nThe app deploys on merge."), fresh);
          yield* store.write(you, everyone, draft("rules/tone.md", "# Tone\n\nShort replies."), fresh);
          const hits = yield* store.search(asPip, [pipsOwn, theApp, everyone], "deploys", 10);
          expect(hits.map((hit) => [hit.scope, hit.path]).sort()).toEqual(
            [
              [pipsOwn, "notes/deploy.md"],
              [theApp, "facts/deploy.md"],
            ].sort(),
          );
          expect(hits.every((hit) => hit.title === "Deploy")).toBe(true);
          expect(yield* store.search(asPip, [everyone], "short", 10)).toMatchObject([{ path: "rules/tone.md" }]);
        }),
      ));

    // covers ADR 028 (the hub is the boundary), #954
    it("[TC-GEN-174] never lets a hob touch another hob's memory or a project it does not work in, and leaves forget and restore to you", () =>
      run(({ store }) =>
        Effect.gen(function* () {
          const path = MemoryPath.make("notes/secret.md");
          const version = yield* store.write(asQuill, quillsOwn, draft("notes/secret.md", "# Quill's own"), fresh);
          expect(yield* died(store.page(asPip, quillsOwn, path))).toBe(true);
          expect(yield* died(store.list(asPip, quillsOwn, 50))).toBe(true);
          expect(yield* died(store.history(asPip, quillsOwn, path))).toBe(true);
          expect(yield* died(store.search(asPip, [pipsOwn, quillsOwn], "own", 10))).toBe(true);
          expect(yield* died(store.write(asPip, quillsOwn, draft("notes/secret.md", "# Pip's now"), any))).toBe(true);
          expect(yield* died(store.forget(asQuill, quillsOwn, path, any))).toBe(true);
          expect(yield* died(store.restore(asQuill, quillsOwn, path, version))).toBe(true);
          expect(yield* store.page(you, quillsOwn, path)).toMatchObject({ version, markdown: "# Quill's own" });
          // A hob reaches the projects it works in and everyone's memory, and no other project.
          yield* store.write(asPip, theApp, draft("facts/app.md", "# App"), fresh);
          yield* store.list(asPip, everyone, 50);
          expect(yield* died(store.list(asPip, theSite, 50))).toBe(true);
          expect(yield* died(store.search(asPip, [theApp, theSite], "app", 10))).toBe(true);
          expect(yield* died(store.write(asPip, theSite, draft("facts/site.md", "# Site"), any))).toBe(true);
          expect(yield* store.list(asQuill, theSite, 50)).toEqual([]);
        }),
      ));

    // covers ADR 028 (forget, restore)
    it("[TC-GEN-175] restores an earlier version, and brings back a page it forgot", () =>
      run(({ store }) =>
        Effect.gen(function* () {
          const path = MemoryPath.make("notes/style.md");
          const first = yield* store.write(asPip, pipsOwn, draft("notes/style.md", "# Style\n\nTabs."), fresh);
          const second = yield* store.write(asPip, pipsOwn, draft("notes/style.md", "# Style\n\nSpaces."), any);
          const restored = yield* store.restore(you, pipsOwn, path, first);
          expect(restored).not.toEqual(first);
          expect(yield* store.page(asPip, pipsOwn, path)).toMatchObject({
            version: restored,
            markdown: "# Style\n\nTabs.",
          });
          expect((yield* store.history(you, pipsOwn, path))[0]).toMatchObject({ version: restored, latest: true });

          const stale = yield* Effect.flip(store.forget(you, pipsOwn, path, { _tag: "Version", version: second }));
          expect(stale).toMatchObject({ _tag: "MemoryConflict", current: restored });
          const point = yield* store.forget(you, pipsOwn, path, { _tag: "Version", version: restored });
          expect(point).not.toBeNull();
          expect(yield* store.page(asPip, pipsOwn, path)).toBeNull();
          expect(yield* store.list(asPip, pipsOwn, 50)).toEqual([]);
          expect(yield* store.history(you, pipsOwn, path)).toEqual([]);
          // Forgetting what is already gone does nothing.
          expect(yield* store.forget(you, pipsOwn, path, any)).toBeNull();
          const back = yield* store.restore(you, pipsOwn, path, point as MemoryVersion);
          expect(yield* store.page(asPip, pipsOwn, path)).toMatchObject({
            version: back,
            markdown: "# Style\n\nTabs.",
          });
        }),
      ));

    // covers ADR 028 (Browse)
    it("[TC-GEN-176] lists pinned pages first, then the newest, up to a limit, and the pages changed since a time", () =>
      run(({ store }) =>
        Effect.gen(function* () {
          yield* store.write(asPip, pipsOwn, draft("notes/a.md", "# A"), fresh);
          const before = new Date(Date.now() - 1000).toISOString();
          yield* store.write(asPip, pipsOwn, draft("notes/b.md", "# B", { pinned: true }), fresh);
          yield* store.write(asPip, pipsOwn, draft("notes/c.md", "# C"), fresh);
          const listed = yield* store.list(asPip, pipsOwn, 50);
          expect(listed[0]).toMatchObject({ path: "notes/b.md", title: "B", pinned: true });
          expect(listed.map((page) => page.path).sort()).toEqual(["notes/a.md", "notes/b.md", "notes/c.md"]);
          // A brief asks for the first few, never the whole memory.
          const firstTwo = yield* store.list(asPip, pipsOwn, 2);
          expect(firstTwo).toHaveLength(2);
          expect(firstTwo[0]).toMatchObject({ path: "notes/b.md" });
          const changed = yield* store.changes(asPip, pipsOwn, before);
          expect(changed.length).toBeGreaterThanOrEqual(2);
          const future = new Date(Date.now() + 60_000).toISOString();
          expect(yield* store.changes(asPip, pipsOwn, future)).toEqual([]);
        }),
      ));
  });
};
