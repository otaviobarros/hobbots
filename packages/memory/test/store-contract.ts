import type { MemoryStoreShape } from "@hobbots/agents";
import {
  AgentId,
  type MemoryActor,
  MemoryConflict,
  type MemoryDraft,
  MemoryForgetDay,
  type MemoryPage,
  MemoryPath,
  type MemoryScope,
  type MemoryVersion,
  memoryProjectIdentity,
  ThreadId,
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
          // Each version names the one it replaced, the first none.
          expect(history.map(({ version, supersedes, latest }) => ({ version, supersedes, latest }))).toEqual([
            { version: second, supersedes: first, latest: true },
            { version: first, supersedes: null, latest: false },
          ]);
          // Every version names who wrote it, the ones before the latest too (#1317).
          expect(history.map((entry) => entry.author)).toEqual([{ _tag: "You" }, byPip]);
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

    // covers ADR 028 (memory_search), #1047
    it("[TC-GEN-1047-01] finds a page by a question in plain words, a word start, a hyphenated name or a short common word", () =>
      run(({ store }) =>
        Effect.gen(function* () {
          yield* store.write(
            asPip,
            theApp,
            draft(
              "facts/tests.md",
              "# How this project runs its tests\n\nThis project runs its tests with `make tide-check`.",
            ),
            fresh,
          );
          yield* store.write(
            asPip,
            theApp,
            draft("facts/deploy.md", "# Deploy\n\nThe project deploys on merge."),
            fresh,
          );
          yield* store.write(asPip, theApp, draft("facts/team.md", "# Team\n\nIT owns the laptops."), fresh);
          const found = (query: string) =>
            Effect.map(store.search(asPip, [theApp], query, 10), (hits) => hits.map((hit) => hit.path));
          for (const query of [
            "tests",
            "make",
            "how this project runs its tests",
            "how does this project run its tests",
            "how this repository runs its tests",
            "run tests",
            "tes",
            "tide",
            "tide-check",
            "Tide-Check?",
          ]) {
            expect([query, (yield* found(query))[0]]).toEqual([query, "facts/tests.md"]);
          }
          // A word that ends the page's word, and words no page holds, find nothing.
          expect(yield* found("check")).toEqual([]);
          expect(yield* found("lint rules")).toEqual([]);
          // A query of nothing but common words still looks for them.
          expect(yield* found("how")).toEqual(["facts/tests.md"]);
          expect((yield* found("deploys")).sort()).toEqual(["facts/deploy.md"]);
          expect((yield* found("project")).sort()).toEqual(["facts/deploy.md", "facts/tests.md"]);
          // A short common word is looked for too, when the page holds no other word of the query.
          expect(yield* found("IT onboarding")).toEqual(["facts/team.md"]);
        }),
      ));

    // covers ADR 028 (memory_search), #1047
    it("[TC-GEN-1047-02] finds a page by a question in another language, the words common to every page weighing least", () =>
      run(({ store }) =>
        Effect.gen(function* () {
          yield* store.write(
            asPip,
            theApp,
            draft(
              "fatos/testes.md",
              "# Como este projeto roda os testes\n\nEste projeto roda os testes com `make tide-check`. Não use `npm test`.",
            ),
            fresh,
          );
          yield* store.write(
            asPip,
            theApp,
            draft(
              "fatos/recados.md",
              "# Como falar com o time\n\nComo este time prefere: os recados curtos, como sempre, do jeito de manhã.",
            ),
            fresh,
          );
          yield* store.write(
            asPip,
            theApp,
            draft("fatos/deploy.md", "# Como este projeto faz deploy\n\nO deploy sai de cada merge, como os outros."),
            fresh,
          );
          const found = (query: string) =>
            Effect.map(store.search(asPip, [theApp], query, 10), (hits) => hits.map((hit) => hit.path));
          for (const query of [
            "como este projeto roda os testes?",
            "como rodar os testes",
            "teste",
            "nao use npm",
            "tide-check",
          ]) {
            expect([query, (yield* found(query))[0]]).toEqual([query, "fatos/testes.md"]);
          }
          // A word of one or two letters matches only as a whole word.
          expect(yield* found("ma")).toEqual([]);
          expect((yield* found("o")).sort()).toEqual(["fatos/deploy.md", "fatos/recados.md"]);
          expect(yield* found("do jeitão")).toEqual(["fatos/recados.md"]);
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
          expect(yield* died(store.restore(asQuill, quillsOwn, path, version, any))).toBe(true);
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

    // covers ADR 028 (Sharing), STD-DATA-001, #960
    it("[TC-GEN-383] answers an earlier version's exact text from one whose text is held, lines in their order", () =>
      run(({ store }) =>
        Effect.gen(function* () {
          const path = MemoryPath.make("howtos/order.md");
          const first = yield* store.write(
            asPip,
            pipsOwn,
            draft("howtos/order.md", "# Steps\n\nBuild.\nTest.\n"),
            fresh,
          );
          // The same lines, in another order, then a later change on top.
          const second = yield* store.write(asPip, pipsOwn, draft("howtos/order.md", "# Steps\n\nTest.\nBuild.\n"), {
            _tag: "Version",
            version: first,
          });
          const third = yield* store.write(
            asPip,
            pipsOwn,
            draft("howtos/order.md", "# Steps\n\nTest.\nBuild.\nShip.\n"),
            { _tag: "Version", version: second },
          );
          const latest = { version: third, markdown: "# Steps\n\nTest.\nBuild.\nShip.\n" };
          expect(yield* store.versionText(you, pipsOwn, path, first, latest)).toBe("# Steps\n\nBuild.\nTest.\n");
          expect(yield* store.versionText(you, pipsOwn, path, second, latest)).toBe("# Steps\n\nTest.\nBuild.\n");
          const firstText = { version: first, markdown: "# Steps\n\nBuild.\nTest.\n" };
          expect(yield* store.versionText(you, pipsOwn, path, second, firstText)).toBe("# Steps\n\nTest.\nBuild.\n");
          // A version of another page has no text here.
          expect(yield* store.versionText(you, pipsOwn, MemoryPath.make("howtos/other.md"), first, latest)).toBeNull();
          // A hob never reads another hob's versions.
          expect(yield* died(store.versionText(asQuill, pipsOwn, path, first, latest))).toBe(true);
        }),
      ));

    // covers ADR 028 (forget, restore)
    it("[TC-GEN-175] restores an earlier version only while the page is as expected, and brings back a page it forgot", () =>
      run(({ store }) =>
        Effect.gen(function* () {
          const path = MemoryPath.make("notes/style.md");
          const first = yield* store.write(asPip, pipsOwn, draft("notes/style.md", "# Style\n\nTabs."), fresh);
          const second = yield* store.write(asPip, pipsOwn, draft("notes/style.md", "# Style\n\nSpaces."), any);
          // A restore against a version that is no longer the latest writes nothing.
          const late = yield* Effect.flip(
            store.restore(you, pipsOwn, path, first, { _tag: "Version", version: first }),
          );
          expect(late).toMatchObject({ _tag: "MemoryConflict", current: second });
          expect(yield* store.page(asPip, pipsOwn, path)).toMatchObject({ version: second });
          const restored = yield* store.restore(you, pipsOwn, path, first, { _tag: "Version", version: second });
          expect(restored).not.toEqual(first);
          expect(yield* store.page(asPip, pipsOwn, path)).toMatchObject({
            version: restored,
            markdown: "# Style\n\nTabs.",
          });
          const afterRestore = yield* store.history(you, pipsOwn, path);
          expect(afterRestore[0]).toMatchObject({ version: restored, latest: true });
          // A restore replaces the version that was the latest, as any write does.
          expect(afterRestore.find((each) => each.supersedes === second)).toBeDefined();

          const stale = yield* Effect.flip(store.forget(you, pipsOwn, path, { _tag: "Version", version: second }));
          expect(stale).toMatchObject({ _tag: "MemoryConflict", current: restored });
          const point = yield* store.forget(you, pipsOwn, path, { _tag: "Version", version: restored });
          expect(point).not.toBeNull();
          expect(yield* store.page(asPip, pipsOwn, path)).toBeNull();
          expect(yield* store.list(asPip, pipsOwn, 50)).toEqual([]);
          expect(yield* store.history(you, pipsOwn, path)).toEqual([]);
          // Forgetting what is already gone does nothing.
          expect(yield* store.forget(you, pipsOwn, path, any)).toBeNull();
          const back = yield* store.restore(you, pipsOwn, path, point as MemoryVersion, { _tag: "New" });
          expect(yield* store.page(asPip, pipsOwn, path)).toMatchObject({
            version: back,
            markdown: "# Style\n\nTabs.",
          });
          // A page written anew after a forget replaces none of the forgotten versions.
          const forgotten = new Set<MemoryVersion | null>([first, second, restored]);
          expect((yield* store.history(you, pipsOwn, path)).some((each) => forgotten.has(each.supersedes))).toBe(false);
        }),
      ));

    // covers ADR 028 (forget, restore), #961
    it("[TC-GEN-349] restores an earlier version line for line, with its blank and last lines", () =>
      run(({ store }) =>
        Effect.gen(function* () {
          const path = MemoryPath.make("notes/launch.md");
          const before = "# Launch\n\n- Monday\n\n  - 9 AM\n- Emails\n\nDecided with you.\n";
          const lines = Array.from({ length: 40 }, (_, i) => `Line ${i}`).join("\n");
          const first = yield* store.write(you, pipsOwn, draft("notes/launch.md", `${before}\n${lines}`), fresh);
          const second = yield* store.write(
            asPip,
            pipsOwn,
            draft("notes/launch.md", `# Launch\n\n- Tuesday\n\n${lines.replace("Line 20", "Twenty")}\nThe end.`),
            any,
          );
          yield* store.restore(you, pipsOwn, path, first, { _tag: "Version", version: second });
          expect((yield* store.page(you, pipsOwn, path))?.markdown).toBe(`${before}\n${lines}`);
        }),
      ));

    // covers ADR 028 (forget, restore), #961
    it("[TC-GEN-349] restores an earlier version line for line, with its blank and last lines", () =>
      run(({ store }) =>
        Effect.gen(function* () {
          const path = MemoryPath.make("notes/launch.md");
          const before = "# Launch\n\n- Monday\n\n  - 9 AM\n- Emails\n\nDecided with you.\n";
          const lines = Array.from({ length: 40 }, (_, i) => `Line ${i}`).join("\n");
          const first = yield* store.write(you, pipsOwn, draft("notes/launch.md", `${before}\n${lines}`), fresh);
          const second = yield* store.write(
            asPip,
            pipsOwn,
            draft("notes/launch.md", `# Launch\n\n- Tuesday\n\n${lines.replace("Line 20", "Twenty")}\nThe end.`),
            any,
          );
          yield* store.restore(you, pipsOwn, path, first, { _tag: "Version", version: second });
          expect((yield* store.page(you, pipsOwn, path))?.markdown).toBe(`${before}\n${lines}`);
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

    // covers ADR 028 (Backups), OP-002
    it(
      "[TC-OP-103] names every page a scope holds as changed since the epoch, past the engine's longest answer",
      () =>
        run(({ store }) =>
          Effect.gen(function* () {
            // 101 pages stay after one is forgotten: more than one answer of the engine holds.
            const paths = Array.from({ length: 102 }, (_, at) => `notes/n${String(at).padStart(3, "0")}.md`);
            const [first = "", ...rest] = paths;
            const version = yield* store.write(you, theApp, draft(first, "# Note"), fresh);
            for (const path of rest) yield* store.write(you, theApp, draft(path, "# Note"), fresh);
            yield* store.forget(you, theApp, MemoryPath.make(first), { _tag: "Version", version });
            const everything = yield* store.changes(you, theApp, "1970-01-01T00:00:00.000Z");
            expect(rest).toHaveLength(101);
            expect(everything.map((page) => page.path).sort()).toEqual(rest);
          }),
        ),
      120_000,
    );

    // covers ADR 028 (Backups), OP-002
    it("[TC-OP-094] names the scopes that hold pages, within what the actor may reach", () =>
      run(({ store }) =>
        Effect.gen(function* () {
          expect(yield* store.scopes(you)).toEqual([]);
          yield* store.write(asPip, pipsOwn, draft("notes/a.md", "# A"), fresh);
          yield* store.write(asQuill, theSite, draft("facts/site.md", "# Site"), fresh);
          yield* store.write(you, everyone, draft("about-you.md", "# About you"), fresh);
          const gone = yield* store.write(asQuill, quillsOwn, draft("notes/b.md", "# B"), fresh);
          yield* store.forget(you, quillsOwn, MemoryPath.make("notes/b.md"), { _tag: "Version", version: gone });
          const key = (scope: MemoryScope) => JSON.stringify(scope);
          // A scope whose only page was forgotten holds nothing to name.
          expect((yield* store.scopes(you)).map(key).sort()).toEqual([pipsOwn, theSite, everyone].map(key).sort());
          expect((yield* store.scopes(asPip)).map(key).sort()).toEqual([pipsOwn, everyone].map(key).sort());
        }),
      ));

    // covers ADR 028 (Browse)
    it("[TC-GEN-192] lists every pinned page first, also more than a search answers and older than the newest", () =>
      run(({ store }) =>
        Effect.gen(function* () {
          const pins = Array.from({ length: 11 }, (_, at) => `pins/p${String(at).padStart(2, "0")}.md`);
          for (const path of pins) yield* store.write(you, theApp, draft(path, "# Pin", { pinned: true }), fresh);
          const before = new Date(Date.now() - 1000).toISOString();
          for (const at of [1, 2, 3, 4, 5]) yield* store.write(you, theApp, draft(`notes/n${at}.md`, "# Note"), fresh);
          const listed = yield* store.list(asPip, theApp, 13);
          expect(listed).toHaveLength(13);
          expect(
            listed
              .slice(0, 11)
              .map((page) => page.path)
              .sort(),
          ).toEqual(pins);
          expect(listed.slice(0, 11).every((page) => page.pinned)).toBe(true);
          expect(listed.slice(11).every((page) => !page.pinned)).toBe(true);
          const changed = yield* store.changes(asPip, theApp, before);
          expect(changed.filter((page) => page.path.startsWith("pins/")).every((page) => page.pinned)).toBe(true);
        }),
      ));

    // covers ADR 028 (Browse)
    it(
      "[TC-GEN-193] keeps every version in a page's history, past the engine's longest answer",
      () =>
        run(({ store }) =>
          Effect.gen(function* () {
            const path = MemoryPath.make("notes/busy.md");
            for (let at = 0; at < 201; at += 1) yield* store.write(you, pipsOwn, draft(path, `# Busy\n\n${at}`), any);
            const versions = yield* store.history(you, pipsOwn, path);
            expect(versions).toHaveLength(201);
            expect(new Set(versions.map((each) => each.version)).size).toBe(201);
            expect(versions.filter((each) => each.latest)).toHaveLength(1);
            expect(versions[0]?.latest).toBe(true);
          }),
        ),
      120_000,
    );

    // covers ADR 028 (Browse), #958
    it("[TC-GEN-230] answers what each version changed against the one it replaced, and nothing for a page it forgot", () =>
      run(({ store }) =>
        Effect.gen(function* () {
          const path = MemoryPath.make("howtos/preview.md");
          const first = yield* store.write(
            asPip,
            pipsOwn,
            draft("howtos/preview.md", "# Preview\n\nAsk Ada.\n"),
            fresh,
          );
          const second = yield* store.write(
            asPip,
            pipsOwn,
            draft("howtos/preview.md", "# Preview\n\nAsk Ada.\n\nLinks last 7 days.\n"),
            { _tag: "Version", version: first },
          );
          // The first version adds all of itself.
          const added = yield* store.versionChanges(you, pipsOwn, path, first);
          expect(added).toMatchObject({ first: true, cut: false });
          expect(added?.lines.filter((line) => line.text !== "")).toEqual([
            { op: "add", text: "# Preview" },
            { op: "add", text: "Ask Ada." },
          ]);
          // A later one adds and removes only what it changed; the rest is kept.
          const changed = yield* store.versionChanges(you, pipsOwn, path, second);
          expect(changed).toMatchObject({ first: false, cut: false });
          expect(changed?.lines).toContainEqual({ op: "add", text: "Links last 7 days." });
          expect(changed?.lines).toContainEqual({ op: "same", text: "Ask Ada." });
          expect(changed?.lines.some((line) => line.op === "remove")).toBe(false);
          // A version of another page, or of a page that is gone, has nothing to show.
          expect(yield* store.versionChanges(you, pipsOwn, MemoryPath.make("howtos/other.md"), first)).toBeNull();
          yield* store.forget(you, pipsOwn, path, any);
          expect(yield* store.versionChanges(you, pipsOwn, path, first)).toBeNull();
          // A hob never reads another hob's versions.
          expect(yield* died(store.versionChanges(asQuill, pipsOwn, path, first))).toBe(true);
        }),
      ));

    // covers ADR 028 (Writes), #959
    it("[TC-GEN-330] keeps a page's forget day until a write clears it, and leaves a page past it out of lists and search", () =>
      run(({ store }) =>
        Effect.gen(function* () {
          const path = MemoryPath.make("notes/launch.md");
          const later = MemoryForgetDay.make("2099-12-31");
          const first = yield* store.write(you, pipsOwn, draft("notes/launch.md", "# Launch\n\nTuesday."), fresh);
          const set = yield* store.write(
            you,
            pipsOwn,
            draft("notes/launch.md", "# Launch\n\nTuesday.", { forgetOn: later }),
            { _tag: "Version", version: first },
          );
          expect(yield* store.page(you, pipsOwn, path)).toMatchObject({ version: set, forgetOn: later, author: you });
          // Until that day it is listed and found like any page.
          expect((yield* store.list(asPip, pipsOwn, 50)).map((page) => page.path)).toEqual([path]);
          const kept = yield* store.write(you, pipsOwn, draft("notes/launch.md", "# Launch\n\nTuesday."), {
            _tag: "Version",
            version: set,
          });
          expect(yield* store.page(you, pipsOwn, path)).toMatchObject({ version: kept, forgetOn: null });
          const history = yield* store.history(you, pipsOwn, path);
          expect(history.map((entry) => entry.version)).toEqual([kept, set, first]);

          // A page whose day is over is gone from lists and search; a read by its path still finds it.
          yield* store.write(
            you,
            pipsOwn,
            draft("notes/old.md", "# Old launch", { forgetOn: MemoryForgetDay.make("2000-01-01") }),
            fresh,
          );
          expect((yield* store.list(asPip, pipsOwn, 50)).map((page) => page.path)).toEqual([path]);
          expect((yield* store.search(asPip, [pipsOwn], "old launch", 10)).map((hit) => hit.path)).toEqual([path]);
          expect(yield* store.page(you, pipsOwn, MemoryPath.make("notes/old.md"))).toMatchObject({
            forgetOn: "2000-01-01",
          });
        }),
      ));

    // covers ADR 028 (attribution), #1317
    it("[TC-GEN-1317-01] names who wrote every version in History: each hob, you, and your restores", () =>
      run(({ store }) =>
        Effect.gen(function* () {
          const path = MemoryPath.make("notes/release.md");
          const first = yield* store.write(asPip, theApp, draft("notes/release.md", "# Release\n\nTag it."), fresh);
          yield* store.write(asPip, theApp, draft("notes/release.md", "# Release\n\nTag it, then push."), any);
          yield* store.write(you, theApp, draft("notes/release.md", "# Release\n\nTag, push, announce."), any);
          yield* store.restore(you, theApp, path, first, any);
          const history = yield* store.history(you, theApp, path);
          // A restore may take more than one version; each is yours.
          expect(history.at(-1)?.version).toEqual(first);
          expect(history.slice(-3).map((entry) => entry.author)).toEqual([you, byPip, byPip]);
          const restored = history.slice(0, -3);
          expect(restored.length).toBeGreaterThan(0);
          for (const entry of restored) expect(entry.author).toEqual(you);
        }),
      ));

    // covers ADR 028 (Writes), #959
    it("[TC-GEN-331] restores a hob's version as a new version written by you, with its tags and pin", () =>
      run(({ store }) =>
        Effect.gen(function* () {
          const path = MemoryPath.make("howtos/deploy.md");
          const first = yield* store.write(
            asPip,
            pipsOwn,
            draft("howtos/deploy.md", "# Deploy\n\nWith fly.", { tags: ["ops"], pinned: true }),
            fresh,
          );
          yield* store.write(asPip, pipsOwn, draft("howtos/deploy.md", "# Deploy\n\nBy hand."), any);
          const restored = yield* store.restore(you, pipsOwn, path, first, any);
          expect(yield* store.page(you, pipsOwn, path)).toMatchObject({
            version: restored,
            markdown: "# Deploy\n\nWith fly.",
            tags: ["ops"],
            pinned: true,
            author: you,
          });
          const history = yield* store.history(you, pipsOwn, path);
          expect(history[0]).toMatchObject({ version: restored, latest: true, author: you });
          // The version it replaced is still in History, and can be restored in turn.
          expect(history.map((entry) => entry.version)).toContain(first);
          const back = yield* store.restore(
            you,
            pipsOwn,
            path,
            history[history.length - 2]?.version as MemoryVersion,
            any,
          );
          expect(yield* store.page(you, pipsOwn, path)).toMatchObject({ version: back, author: you });
        }),
      ));

    // covers ADR 028 (Capture and summaries), #959
    it("[TC-GEN-332] never rewrites a chat note you pinned when its thread's session ends again", () =>
      run(({ store }) =>
        Effect.gen(function* () {
          const thread = ThreadId.make("0d6e2f0a-0000-4000-8000-0000000000f2");
          const path = MemoryPath.make(`sessions/${thread}.md`);
          yield* store.capture(asPip, pipsOwn, thread, [
            { key: "message:m1", kind: "message", text: "How do the tests run?" },
          ]);
          expect(yield* store.endSession(asPip, pipsOwn, thread, "end:m1")).toBe(true);
          const note = yield* store.page(you, pipsOwn, path);
          expect(note).not.toBeNull();
          const pinned = yield* store.write(
            you,
            pipsOwn,
            draft(path, note?.markdown ?? "", { tags: note?.tags ?? [], pinned: true }),
            { _tag: "Version", version: note?.version as MemoryVersion },
          );
          // The thread goes on and ends again: the pinned note stays as it was.
          yield* store.capture(asPip, pipsOwn, thread, [
            { key: "message:m2", kind: "message", text: "And the linter?" },
          ]);
          // The end is put off, not taken: memory answers that it waits.
          expect(yield* store.endSession(asPip, pipsOwn, thread, "end:m2")).toBe(false);
          const after = yield* store.page(you, pipsOwn, path);
          expect(after).toMatchObject({ version: pinned, pinned: true, author: you });
          expect(after?.markdown).not.toContain("And the linter?");
        }),
      ));

    // covers ADR 028 (Capture and summaries), #1316
    it("[TC-GEN-1316-01] names a chat's page by its summary's title when it is read, as every list names it", () =>
      run(({ store }) =>
        Effect.gen(function* () {
          const thread = ThreadId.make("0d6e2f0a-0000-4000-8000-0000000000f3");
          const path = MemoryPath.make(`sessions/${thread}.md`);
          const read = Effect.map(store.page(you, pipsOwn, path), (page) => page as MemoryPage);
          const listedTitle = Effect.map(store.list(you, pipsOwn, 50), (pages) =>
            pages.filter((each) => each.path === path).map((each) => each.title),
          );
          const rewrite = (page: MemoryPage, markdown: string) =>
            store.write(you, pipsOwn, draft(path, markdown, { pinned: true }), {
              _tag: "Version",
              version: page.version,
            });
          yield* store.capture(asPip, pipsOwn, thread, [
            { key: "message:m1", kind: "message", text: "How do the tests run?" },
          ]);
          yield* store.endSession(asPip, pipsOwn, thread, "end:m1");
          const [title] = yield* listedTitle;
          expect(title).toBeTruthy();
          expect(title).not.toContain(thread);
          const note = yield* read;
          expect(note.title).toBe(title);
          // Pinning it writes its markdown again, and it keeps its title.
          yield* rewrite(note, note.markdown);
          const pinned = yield* read;
          expect(pinned.title).toBe(title);
          // Given a heading, as the editor writes a title, it is named by it.
          yield* rewrite(pinned, `# Test runs\n\n${pinned.markdown}`);
          expect((yield* read).title).toBe("Test runs");
          expect(yield* listedTitle).toEqual(["Test runs"]);
        }),
      ));

    // covers ADR 028 (The MemoryStore service, Capture and summaries)
    it("[TC-GEN-307] keeps a thread's capture in its hob's own memory, refusing any other scope", () =>
      run(({ store }) =>
        Effect.gen(function* () {
          const thread = ThreadId.make("0d6e2f0a-0000-4000-8000-0000000000f1");
          const items = [{ key: "message:m1", kind: "message", text: "How do the tests run?" }] as const;
          expect(yield* store.capture(asPip, pipsOwn, thread, items)).toBe(1);
          // Sent again, it is acknowledged and skipped.
          expect(yield* store.capture(asPip, pipsOwn, thread, items)).toBe(1);
          yield* store.endSession(asPip, pipsOwn, thread, "end:m1");
          const page = yield* store.page(you, pipsOwn, MemoryPath.make(`sessions/${thread}.md`));
          expect(page?.markdown).toContain("How do the tests run?");
          expect(page?.author).toEqual(byPip);
          for (const scope of [quillsOwn, theApp, everyone]) {
            expect(yield* died(store.capture(asPip, scope, thread, items))).toBe(true);
            expect(yield* died(store.endSession(asPip, scope, thread, "end:m1"))).toBe(true);
          }
        }),
      ));

    // covers ADR 028 (Sharing), #960
    it("[TC-GEN-372] checks a scope for pages that disagree or look out of date, changing nothing, for you alone", () =>
      run(({ store }) =>
        Effect.gen(function* () {
          yield* store.write(you, theSite, draft("howtos/deploy.md", "# Deploy\n\nRun `pnpm deploy`."), fresh);
          yield* store.write(you, theSite, draft("facts/stack.md", "# Stack\n\nThe site is built with Astro."), fresh);
          const before = yield* store.list(you, theSite, 50);
          expect(yield* store.check(you, theSite)).toEqual([]);
          expect(yield* store.check(you, everyone)).toEqual([]);
          // Nothing new among your pages, such as a report of its own.
          expect(yield* store.list(you, theSite, 50)).toEqual(before);
          // Check now is yours: a hob never runs it.
          expect(yield* died(store.check(asQuill, theSite))).toBe(true);
        }),
      ));
  });
};
