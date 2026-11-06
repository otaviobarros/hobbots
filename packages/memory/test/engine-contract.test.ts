import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { NodeServices } from "@effect/platform-node";
import { Context, Effect, Exit, Layer, Option, Redacted, Schedule, Scope } from "effect";
import { FetchHttpClient } from "effect/http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { restoreMemoryArchive } from "../src/engine/backup.ts";
import { configHoldsCredential, ROOT_USERNAME } from "../src/engine/config.ts";
import { MEMORY_WORKSPACE, type MemoryEndpoint, MemoryEngine, memoryFolder } from "../src/engine/engine.ts";
import { loadOrCreateMemoryKeys, type MemoryKeys, replaceMemoryKeys } from "../src/engine/keys.ts";
import { AI_MEMORY_VERSION } from "../src/engine/release.ts";
import { testEngine } from "../src/testing.ts";

// Contract tests against the bundled ai-memory release (ADR 028): every route and setting Hobbots
// relies on, run on the real binary, so an upstream release that changes one fails here before a
// user finds it. They need the engine fetched (`pnpm --filter @hobbots/memory fetch-engine`). CI
// sets HOBBOTS_MEMORY_CONTRACT=1, which fails them when it is not; elsewhere they are skipped.
const { folder, fetched, enabled } = testEngine;

const dataDir = mkdtempSync(join(tmpdir(), "hobbots-memory-contract-"));
/** Where a backup of `dataDir`'s memory is restored. */
const restoredDir = mkdtempSync(join(tmpdir(), "hobbots-memory-restored-"));
let scope: Scope.Closeable | undefined;
let engine: MemoryEngine["Service"];
let endpoint: MemoryEndpoint;
let keys: MemoryKeys;

/** Starts the engine on `data` with `withKeys` in `opened`, where it runs until that scope closes. */
const startEngine = (data: string, withKeys: MemoryKeys, opened: Scope.Scope) => {
  const layer = MemoryEngine.layer({ folder: folder ?? "", dataDir: data, keys: withKeys }).pipe(
    Layer.provide(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer)),
  );
  return Effect.gen(function* () {
    const started = Context.get(yield* Layer.buildWithScope(layer, opened), MemoryEngine);
    yield* started.health.pipe(
      Effect.repeat({ schedule: Schedule.spaced("100 millis"), until: (health) => health.state !== "starting" }),
      Effect.timeout("60 seconds"),
    );
    const at = Option.getOrThrowWith(yield* started.endpoint, () => new Error("The memory engine did not start"));
    return { engine: started, endpoint: at };
  }).pipe(Effect.runPromise);
};

beforeAll(async () => {
  if (!enabled) return;
  if (!fetched) throw new Error(`No ai-memory engine in ${folder}; run pnpm --filter @hobbots/memory fetch-engine`);
  keys = loadOrCreateMemoryKeys(dataDir);
  const opened = await Effect.runPromise(Scope.make());
  scope = opened;
  ({ engine, endpoint } = await startEngine(dataDir, keys, opened));
}, 90_000);

afterAll(async () => {
  if (scope !== undefined) await Effect.runPromise(Scope.close(scope, Exit.void));
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(restoredDir, { recursive: true, force: true });
});

type Caller =
  | { readonly as: "root" }
  | { readonly as: "hob"; readonly hob: string }
  | { readonly as: "bearer"; readonly bearer: string };

const headersFor = (caller: Caller, extra: Record<string, string> = {}): Record<string, string> => {
  switch (caller.as) {
    case "root":
      return { authorization: `Bearer ${Redacted.value(keys.root)}`, ...extra };
    case "hob":
      return {
        authorization: `Bearer ${Redacted.value(keys.proxy)}`,
        "x-memory-actor-user": `hob-${caller.hob}`,
        ...extra,
      };
    case "bearer":
      return { authorization: `Bearer ${caller.bearer}`, ...extra };
  }
};

const call = async (
  caller: Caller,
  path: string,
  init: { method?: string; body?: unknown; headers?: Record<string, string>; at?: MemoryEndpoint } = {},
) => {
  const response = await fetch(`${(init.at ?? endpoint).url}${path}`, {
    method: init.method ?? (init.body === undefined ? "GET" : "POST"),
    headers: headersFor(caller, {
      ...(init.body === undefined ? {} : { "content-type": "application/json" }),
      ...init.headers,
    }),
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  return response;
};
const json = async (caller: Caller, path: string, init: Parameters<typeof call>[2] = {}) => {
  const response = await call(caller, path, init);
  expect(response.status, `${init.method ?? "GET"} ${path}`).toBe(200);
  return (await response.json()) as Record<string, unknown> & Array<Record<string, unknown>>;
};

let mcpId = 0;
const mcp = async (hob: string, method: string, params: unknown) => {
  const body = (await json({ as: "hob", hob }, "/mcp", {
    body: { jsonrpc: "2.0", id: ++mcpId, method, params },
    headers: { accept: "application/json, text/event-stream" },
  })) as { result?: Record<string, unknown>; error?: unknown };
  expect(body.error).toBeUndefined();
  return body.result ?? {};
};
const tool = async (hob: string, name: string, args: Record<string, unknown>) => {
  const result = (await mcp(hob, "tools/call", { name, arguments: args })) as {
    content: Array<{ text: string }>;
    isError: boolean;
  };
  expect(result.isError, result.content[0]?.text).toBe(false);
  return JSON.parse(result.content[0]?.text ?? "null") as Record<string, unknown>;
};

const project = (name: string) => `/api/v1/workspaces/${MEMORY_WORKSPACE}/projects/${name}`;

describe.runIf(enabled)(`the bundled ai-memory ${AI_MEMORY_VERSION}`, () => {
  // covers ADR 028
  it("[TC-GEN-183] serves the hub's data folder from the hub's config, which holds no credential", async () => {
    const health = await fetch(`${endpoint.url}/healthz`);
    expect(await health.json()).toEqual({ status: "ok" });
    const memory = join(dataDir, "memory");
    expect(readdirSync(memory)).toEqual(expect.arrayContaining(["config.toml", "db", "wiki"]));
    // ai-memory writes no bearer into the config it was given, nor into any other config file.
    for (const file of readdirSync(memory).filter((name) => name.endsWith(".toml"))) {
      expect(configHoldsCredential(readFileSync(join(memory, file), "utf8"), keys), file).toBe(false);
    }
  });

  // covers ADR 028
  it("[TC-GEN-184] takes the root bearer from AI_MEMORY_AUTH_TOKEN and attributes it to you", async () => {
    expect(await json({ as: "root" }, "/identity")).toMatchObject({
      version: AI_MEMORY_VERSION,
      level: "root",
      operator: `user:${ROOT_USERNAME}`,
    });
    // An actor header on the root bearer is ignored: only the proxy bearer may assert a hob.
    expect(await json({ as: "root" }, "/identity", { headers: { "x-memory-actor-user": "hob-spoof" } })).toMatchObject({
      operator: `user:${ROOT_USERNAME}`,
    });
    expect((await call({ as: "bearer", bearer: "0".repeat(64) }, "/api/v1/projects")).status).toBe(401);
    expect((await fetch(`${endpoint.url}/api/v1/projects`)).status).toBe(401);
  });

  // covers ADR 028
  it("[TC-GEN-185] takes the proxy bearer from AI_MEMORY_AUTH__ACTOR_PROXY_BEARER_TOKEN and acts as the asserted hob", async () => {
    expect(await json({ as: "hob", hob: "h1" }, "/identity")).toMatchObject({ level: "user", operator: "user:hob-h1" });
    // The proxy bearer without an asserted actor is refused, never treated as root.
    const anonymous = await call({ as: "bearer", bearer: Redacted.value(keys.proxy) }, "/identity");
    expect(anonymous.status).toBe(400);
  });

  // covers ADR 028
  it("[TC-GEN-186] writes and searches pages over /mcp as the hob that the proxy asserts", async () => {
    await mcp("h1", "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "hobbots", version: "contract" },
    });
    const tools = (await mcp("h1", "tools/list", {})) as { tools: Array<{ name: string }> };
    expect(tools.tools.map((each) => each.name)).toEqual(
      expect.arrayContaining(["memory_query", "memory_write_page", "memory_read_page"]),
    );
    const written = await tool("h1", "memory_write_page", {
      workspace: MEMORY_WORKSPACE,
      project: "hob-h1",
      path: "notes/tests.md",
      body: "# Tests\n\nRun pnpm check before handing work back.",
      tags: ["thread:t1"],
    });
    expect(written).toMatchObject({ path: "notes/tests.md" });
    // The author is the hob, recorded in the page's own frontmatter.
    const page = await json({ as: "root" }, `${project("hob-h1")}/pages/notes/tests.md`);
    expect(page.frontmatter).toMatchObject({ last_modified_by: { username: "hob-h1" } });

    const found = await tool("h1", "memory_query", {
      workspace: MEMORY_WORKSPACE,
      project: "hob-h1",
      query: "pnpm check",
    });
    expect(found.hits).toEqual(expect.arrayContaining([expect.objectContaining({ path: "notes/tests.md" })]));
  });

  // covers ADR 028
  it("[TC-GEN-187] captures events through /hook/batch and skips a replayed ingest key", async () => {
    const event = (name: string, key: string, body: Record<string, unknown>) => ({
      url: `/hook?event=${name}&agent=hobbots&workspace=${MEMORY_WORKSPACE}&project=hob-h2&extension=hobbots&source_event=${name}&ingest_key=${key}`,
      body: { session_id: "thread-1", cwd: dataDir, ...body },
    });
    const batch = [
      event("session-start", "hobbots-entry-1", {}),
      event("user-prompt-submit", "hobbots-entry-2", { prompt: "How do the tests run here?" }),
    ];
    const first = await json({ as: "hob", hob: "h2" }, "/hook/batch", { body: batch });
    expect(first).toMatchObject({
      accepted: 2,
      results: [
        { index: 0, outcome: "stored" },
        { index: 1, outcome: "stored" },
      ],
    });
    const observations = async () => {
      const projects = await json({ as: "root" }, "/api/v1/projects");
      return projects.find((each) => each.project_name === "hob-h2")?.observation_count;
    };
    const stored = await observations();
    expect(stored).toBe(2);

    const replay = await json({ as: "hob", hob: "h2" }, "/hook/batch", { body: batch });
    expect(replay).toMatchObject({
      accepted: 2,
      results: [
        { index: 0, outcome: "replayed" },
        { index: 1, outcome: "replayed" },
      ],
    });
    expect(await observations()).toBe(stored);
  });

  // covers ADR 028
  it("[TC-GEN-188] reads pages, history and search over /api/v1", async () => {
    const pages = await json({ as: "root" }, `${project("hob-h1")}/pages`);
    expect(pages).toEqual(expect.arrayContaining([expect.objectContaining({ path: "notes/tests.md" })]));
    const page = await json({ as: "root" }, `${project("hob-h1")}/pages/notes/tests.md`);
    expect(page).toMatchObject({ path: "notes/tests.md", title: "Tests", pinned: false });
    expect(page.body_markdown).toContain("pnpm check");
    const history = await json({ as: "root" }, `${project("hob-h1")}/history/notes/tests.md`);
    expect(history).toMatchObject({ total: 1, versions: [expect.objectContaining({ id: page.id, is_latest: true })] });
    const hits = await json({ as: "root" }, `/api/v1/search?q=pnpm&workspace=${MEMORY_WORKSPACE}&project=hob-h1`);
    expect(hits).toEqual(expect.arrayContaining([expect.objectContaining({ path: "notes/tests.md" })]));
  });

  // covers ADR 028
  it("[TC-GEN-189] edits pages over /admin as you, and backs up with no credential inside", async () => {
    const write = { workspace: MEMORY_WORKSPACE, project: "hob-h1", path: "notes/tests.md" };
    await json({ as: "root" }, "/admin/write-page", {
      body: { ...write, body: "# Tests\n\nRun pnpm check, then pnpm test:pg." },
      headers: { "x-memory-actor-user": "hob-spoof" },
    });
    const page = await json({ as: "root" }, `${project("hob-h1")}/pages/notes/tests.md`);
    expect(page.frontmatter).toMatchObject({ last_modified_by: { username: ROOT_USERNAME } });
    const history = await json({ as: "root" }, `${project("hob-h1")}/history/notes/tests.md`);
    expect(history.total).toBe(2);

    await json({ as: "root" }, "/admin/write-page", {
      body: { ...write, path: "notes/scratch.md", body: "# Scratch" },
    });
    await json({ as: "root" }, "/admin/delete-page", { body: { ...write, path: "notes/scratch.md" } });
    expect((await call({ as: "root" }, `${project("hob-h1")}/pages/notes/scratch.md`)).status).toBe(404);

    // A hob cannot reach the routes that are yours alone.
    expect(
      (await call({ as: "hob", hob: "h1" }, "/admin/write-page", { body: { ...write, body: "# x" } })).status,
    ).toBe(403);

    const backup = await call({ as: "root" }, "/admin/backup", { method: "POST" });
    expect(backup.status).toBe(200);
    const tarball = gunzipSync(Buffer.from(await backup.arrayBuffer())).toString("latin1");
    expect(tarball).toContain("config.toml");
    expect(tarball).not.toContain(Redacted.value(keys.root));
    expect(tarball).not.toContain(Redacted.value(keys.proxy));
  });

  // covers ADR 028 (Backups), OP-003
  it("[TC-OP-098] restores a backup with every page and its history, and the old bearers no longer work", async () => {
    const archive = join(restoredDir, "ai-memory.tar.gz");
    expect(await Effect.runPromise(engine.backup(archive))).toBe(true);

    // What a restore does: unpack memory into a new data folder, and give the hub new bearers.
    await Effect.runPromise(restoreMemoryArchive(archive, memoryFolder(restoredDir)));
    replaceMemoryKeys(restoredDir);
    const fresh = loadOrCreateMemoryKeys(restoredDir);
    expect(Redacted.value(fresh.root)).not.toBe(Redacted.value(keys.root));
    const opened = await Effect.runPromise(Scope.make());
    try {
      const restored = (await startEngine(restoredDir, fresh, opened)).endpoint;
      const asNew = { as: "bearer", bearer: Redacted.value(fresh.root) } as const;
      const page = await call(asNew, `${project("hob-h1")}/pages/notes/tests.md`, { at: restored });
      expect(page.status).toBe(200);
      expect(((await page.json()) as { body_markdown: string }).body_markdown).toContain("pnpm test:pg");
      const history = await call(asNew, `${project("hob-h1")}/history/notes/tests.md`, { at: restored });
      expect(((await history.json()) as { total: number }).total).toBe(2);
      // The index came back with it: search finds the page.
      const hits = await call(asNew, `/api/v1/search?q=pnpm&workspace=${MEMORY_WORKSPACE}&project=hob-h1`, {
        at: restored,
      });
      expect(await hits.json()).toEqual(expect.arrayContaining([expect.objectContaining({ path: "notes/tests.md" })]));

      // Neither old bearer reaches the restored memory.
      expect((await call({ as: "root" }, "/identity", { at: restored })).status).toBe(401);
      expect((await call({ as: "hob", hob: "h1" }, "/identity", { at: restored })).status).toBe(401);
    } finally {
      await Effect.runPromise(Scope.close(opened, Exit.void));
    }
  }, 90_000);
});
