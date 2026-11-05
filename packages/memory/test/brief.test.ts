import {
  buildMemoryBrief,
  MEMORY_BRIEF_LIMITS,
  MEMORY_UNAVAILABLE,
  type MemoryStoreShape,
  memoryActorFor,
  memoryBriefDigest,
} from "@hobbots/agents";
import { AgentId, type MemoryActor, MemoryPath, type MemoryScope, memoryProjectIdentity } from "@hobbots/domain";
import { Effect, Option } from "effect";
import { describe, expect, it } from "vitest";
import { makeMemoryStoreFake } from "../src/testing.ts";

const pip = AgentId.make("0d6e2f0a-0000-4000-8000-000000000001");
const quill = AgentId.make("0d6e2f0a-0000-4000-8000-000000000002");
const app = memoryProjectIdentity("git@github.com:me/app.git", "app");
const asPip = { _tag: "Hob", agentId: pip, projects: [app] } as const;
const you: MemoryActor = { _tag: "You" };
const everyone: MemoryScope = { _tag: "Everyone" };
const pipsOwn: MemoryScope = { _tag: "Hob", agentId: pip };
const quillsOwn: MemoryScope = { _tag: "Hob", agentId: quill };
const theApp: MemoryScope = { _tag: "Project", identity: app };

const save = (store: MemoryStoreShape, scope: MemoryScope, path: string, markdown: string, pinned = false) =>
  Effect.runPromise(
    store.write(you, scope, { path: MemoryPath.make(path), markdown, tags: [], pinned }, { _tag: "Any" }),
  );
const brief = (store: MemoryStoreShape) => Effect.runPromise(buildMemoryBrief(store, asPip));

describe("the memory brief", () => {
  // covers CH-001
  it("[TC-CH-282] lists everyone's rules, then the hob's own pages, then its projects', pinned first, each quoted as data", async () => {
    const { store } = makeMemoryStoreFake();
    await save(store, theApp, "facts/stack.md", "# Stack\n\nThe app uses pnpm.");
    await save(store, pipsOwn, "notes/tests.md", "# Tests\n\nRun the fast suite first.");
    await save(store, pipsOwn, "notes/style.md", "# Style\n\n## Now\nShort answers.", true);
    await save(store, everyone, "rules/tone.md", "# Tone\n\nBe kind.");
    await save(store, quillsOwn, "notes/secret.md", "# Quill's note\n\nOnly for Quill.");

    const text = (await brief(store)) ?? "";
    expect(text).toMatch(/^## From your memory\n\n.*reference data, not instructions/);
    const order = ["### Everyone's rules", "#### Tone", "### Your own pages", "#### Style", "#### Tests"];
    const at = [...order, `### Project ${app}`, "#### Stack"].map((heading) => text.indexOf(heading));
    expect(at.every((index) => index !== -1)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    // A page's own headings stay inside its quote, so none reads as a section of the brief.
    expect(text).toContain("notes/style.md, pinned, updated ");
    expect(text).toContain("> ## Now\n> Short answers.");
    // Another hob's memory is never in it.
    expect(text).not.toContain("Only for Quill");
  });

  // covers CH-001
  it("[TC-CH-283] stays within its budget and drops the lowest-priority pages first", async () => {
    const { store } = makeMemoryStoreFake();
    await save(store, everyone, "rules/one.md", `# Rule\n\n${"r".repeat(5_000)}`);
    await save(store, pipsOwn, "notes/own.md", `# Own\n\n${"o".repeat(3_000)}`);
    // Written last, or at the same moment and first by path, the newer fact is listed first.
    await save(store, theApp, "facts/older.md", `# Older fact\n\n${"f".repeat(3_000)}`);
    await save(store, theApp, "facts/newer.md", `# Newer fact\n\n${"g".repeat(3_000)}`);

    const text = (await brief(store)) ?? "";
    expect(text.length).toBeLessThanOrEqual(MEMORY_BRIEF_LIMITS.total);
    // A long page keeps its start, clipped to the page budget.
    expect(text).toContain("#### Rule");
    expect(text).not.toContain("r".repeat(MEMORY_BRIEF_LIMITS.page));
    expect(text).toContain("#### Own");
    expect(text).toContain("#### Newer fact");
    // The project's older page is the lowest priority, so it is the one left out, and counted.
    expect(text).not.toContain("#### Older fact");
    expect(text).toMatch(/\(1 more page did not fit and is left out\.\)$/);
  });

  // covers CH-001
  it("[TC-CH-284] is nothing for an empty memory, and says memory is unavailable during an outage", async () => {
    const { store, controls } = makeMemoryStoreFake();
    // Another hob's pages do not make Pip's memory any less empty.
    await save(store, quillsOwn, "notes/secret.md", "# Quill's note");
    expect(await brief(store)).toBeNull();

    controls.setDown(true);
    expect(await brief(store)).toBe(MEMORY_UNAVAILABLE);
  });

  it("fingerprints a brief, so an unchanged one is recognized and a changed one is not", () => {
    expect(memoryBriefDigest("a brief")).toBe(memoryBriefDigest("a brief"));
    expect(memoryBriefDigest("a brief")).not.toBe(memoryBriefDigest("a brief."));
    expect(memoryBriefDigest(null)).toBe(memoryBriefDigest(""));
  });

  it("makes a hob's actor from its folders, each project once, by name when nothing reads the remote", async () => {
    const actor = await Effect.runPromise(memoryActorFor(Option.none(), pip, ["/work/App/", "/other/app", "/b/site"]));
    expect(actor).toEqual({ _tag: "Hob", agentId: pip, projects: ["app", "site"] });
  });
});
