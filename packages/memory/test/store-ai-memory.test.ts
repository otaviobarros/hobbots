import type { MemoryStoreShape } from "@hobbots/agents";
import {
  AgentId,
  MemoryForgetDay,
  MemoryPath,
  type MemoryScope,
  MemoryUnavailable,
  memoryProjectIdentity,
} from "@hobbots/domain";
import { Effect, Exit, Redacted, Scope } from "effect";
import { describe, expect, it, vi } from "vitest";
import { engineProjectOf, INDEX_PROJECT, scopeOfEngineProject } from "../src/store/scopes.ts";
import { engineDataDir, engineEnabled, startEngineStore } from "./engine-store.ts";
import { memoryStoreContract } from "./store-contract.ts";

// The shared MemoryStore tests on the bundled ai-memory (ADR 028), run as the engine's contract tests
// are: skipped without the engine, and failed for its absence in CI (HOBBOTS_MEMORY_CONTRACT=1).

vi.setConfig({ testTimeout: 60_000 });

// Effect's fetch client takes `globalThis.fetch` once, so a test that steps in between a store's
// requests and the engine sets `beforeFetch` instead of replacing it.
const realFetch = globalThis.fetch;
let beforeFetch: ((url: string) => Promise<void>) | undefined;
globalThis.fetch = async (input, init) => {
  await beforeFetch?.(input instanceof Request ? input.url : String(input));
  return realFetch(input, init);
};

const open = () =>
  Effect.gen(function* () {
    const { dataDir, keys } = engineDataDir();
    const first = yield* startEngineStore(dataDir, keys);
    // A second run: the engine stops with the hub and starts again on the same data.
    const reopen: Effect.Effect<MemoryStoreShape> = Effect.gen(function* () {
      yield* Scope.close(first.scope, Exit.void);
      return (yield* startEngineStore(dataDir, keys)).store;
    });
    return { store: first.store, reopen, endpoint: first.endpoint, keys };
  });

describe.runIf(engineEnabled)("the ai-memory MemoryStore", () => {
  memoryStoreContract("ai-memory", open);
});

describe("ai-memory scopes", () => {
  it("keeps each scope in its own ai-memory project", () => {
    const app = memoryProjectIdentity("git@github.com:me/app.git", "app");
    const lookalike = memoryProjectIdentity("git@github.com:me-app/x.git", "x");
    expect(engineProjectOf({ _tag: "Everyone" })).toEqual({ workspace: "default", project: "_global" });
    expect(engineProjectOf({ _tag: "Project", identity: app }).project).toMatch(
      /^repo-github\.com-me-app-[0-9a-f]{10}$/,
    );
    // Identities that read alike as a project name still get projects of their own.
    expect(engineProjectOf({ _tag: "Project", identity: lookalike }).project).not.toBe(
      engineProjectOf({ _tag: "Project", identity: memoryProjectIdentity("git@github.com:me/app-x.git", "x") }).project,
    );
  });

  // covers ADR 028 (Backups), OP-002
  it("[TC-OP-101] reads each engine project back as the scope it holds", () => {
    const app = memoryProjectIdentity("git@github.com:me/app.git", "app");
    const pip = AgentId.make("h-pip");
    for (const scope of [{ _tag: "Everyone" }, { _tag: "Hob", agentId: pip }] as const) {
      expect(scopeOfEngineProject(engineProjectOf(scope))).toEqual(scope);
    }
    // A project's engine name is hashed, so only the index names its identity.
    expect(scopeOfEngineProject(engineProjectOf({ _tag: "Project", identity: app }))).toBe("Project");
    expect(scopeOfEngineProject(INDEX_PROJECT)).toBe(null);
    expect(scopeOfEngineProject({ workspace: "hobbots", project: "scratch" })).toBe(null);
    expect(scopeOfEngineProject({ workspace: "other", project: "hob-h-pip" })).toBe(null);
  });
});

describe.runIf(engineEnabled)("ai-memory projects Hobbots did not make", () => {
  // covers ADR 028 (Backups), OP-002
  it("[TC-OP-102] says memory did not answer in full rather than leave a project it cannot name out", async () => {
    const { store, endpoint, keys } = await Effect.runPromise(open());
    const app: MemoryScope = { _tag: "Project", identity: memoryProjectIdentity("git@github.com:me/app.git", "app") };
    const you = { _tag: "You" } as const;
    const draft = (path: string) => ({ path: MemoryPath.make(path), markdown: "# Page", tags: [], pinned: false });
    await Effect.runPromise(store.write(you, app, draft("a.md"), { _tag: "New" }));
    expect(await Effect.runPromise(store.scopes(you))).toEqual([app]);
    // Pages ai-memory took in some other way, in a project no index page names.
    const response = await fetch(`${endpoint.url}/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${Redacted.value(keys.root)}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "memory_write_page",
          arguments: { workspace: "hobbots", project: "repo-foreign-0123456789", path: "c.md", body: "# Page" },
        },
      }),
    });
    expect(response.status).toBe(200);
    const refused = await Effect.runPromise(Effect.flip(store.scopes(you)));
    expect(refused).toBeInstanceOf(MemoryUnavailable);
    expect(refused.message).toMatch(/repo-foreign-0123456789/);
  });

  // covers ADR 028 (Writes), #961
  it("[TC-GEN-348] refuses a restore when ai-memory changes the page after the restore checked it, and puts that change back", async () => {
    const { store, endpoint, keys } = await Effect.runPromise(open());
    const pip: MemoryScope = { _tag: "Hob", agentId: AgentId.make("0d6e2f0a-0000-4000-8000-000000000031") };
    const you = { _tag: "You" } as const;
    const path = MemoryPath.make("sessions/thread-1.md");
    const draft = (markdown: string) => ({ path, markdown, tags: [], pinned: false });
    const first = await Effect.runPromise(store.write(you, pip, draft("# Session\n\nMonday."), { _tag: "New" }));
    const second = await Effect.runPromise(store.write(you, pip, draft("# Session\n\nTuesday."), { _tag: "Any" }));
    // ai-memory writes the page itself, as a session's summary does, once the restore has checked it.
    const where = engineProjectOf(pip);
    const engineWrite = () =>
      realFetch(`${endpoint.url}/mcp`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${Redacted.value(keys.root)}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "memory_write_page",
            arguments: { ...where, path, body: "# Session\n\nThe summary." },
          },
        }),
      });
    let wrote = false;
    beforeFetch = async (url) => {
      if (wrote || !url.includes("/admin/restore-page")) return;
      wrote = true;
      expect((await engineWrite()).status).toBe(200);
    };
    try {
      const refused = await Effect.runPromise(
        Effect.flip(store.restore(you, pip, path, first, { _tag: "Version", version: second })),
      );
      expect(wrote).toBe(true);
      expect(refused).toMatchObject({ _tag: "MemoryConflict" });
    } finally {
      beforeFetch = undefined;
    }
    expect(await Effect.runPromise(store.page(you, pip, path))).toMatchObject({
      markdown: "# Session\n\nThe summary.",
    });
  });
});

describe.runIf(engineEnabled)("aging on ai-memory", () => {
  // covers ADR 028 (Writes), #959
  it("[TC-GEN-333] has the engine's sweep delete a page past its forget day for good, and leave a pinned page as it is", async () => {
    const { store, endpoint, keys } = await Effect.runPromise(open());
    const you = { _tag: "You" } as const;
    const own: MemoryScope = { _tag: "Hob", agentId: AgentId.make("h-pip") };
    const write = (path: string, more: { pinned?: boolean; forgetOn?: MemoryForgetDay }) =>
      Effect.runPromise(
        store.write(
          you,
          own,
          { path: MemoryPath.make(path), markdown: "# Page", tags: [], pinned: false, ...more },
          {
            _tag: "New",
          },
        ),
      );
    const pinned = await write("rules/kept.md", { pinned: true });
    await write("notes/gone.md", { forgetOn: MemoryForgetDay.make("2000-01-01") });
    const sweep = await fetch(`${endpoint.url}/admin/forget-sweep`, {
      method: "POST",
      headers: { authorization: `Bearer ${Redacted.value(keys.root)}`, "content-type": "application/json" },
      body: JSON.stringify(engineProjectOf(own)),
    });
    expect(sweep.status).toBe(200);
    expect(await sweep.json()).toMatchObject({ expired: [expect.objectContaining({ path: "notes/gone.md" })] });
    expect(await Effect.runPromise(store.page(you, own, MemoryPath.make("notes/gone.md")))).toBeNull();
    expect(await Effect.runPromise(store.history(you, own, MemoryPath.make("notes/gone.md")))).toEqual([]);
    expect(await Effect.runPromise(store.page(you, own, MemoryPath.make("rules/kept.md")))).toMatchObject({
      version: pinned,
      pinned: true,
    });
  });
});
