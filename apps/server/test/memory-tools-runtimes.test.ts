import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type CharmTurn,
  MemoryProjects,
  MemorySaves,
  MemoryStore,
  type MemoryStoreShape,
  MemoryTools,
  makeRedactor,
  PrivateCamps,
  type ToolAccess,
} from "@hobbots/agents";
import {
  AgentId,
  EMPTY_HOB_POLICY,
  MEMORY_SAVE_TOOL,
  MEMORY_SEARCH_TOOL,
  memoryProjectIdentity,
  ThreadId,
} from "@hobbots/domain";
import { MemoryToolsLive, PRIVATE_CAMP_SAVE } from "@hobbots/memory";
import { makeMemorySavesFake, makeMemoryStoreFake } from "@hobbots/memory/testing";
import { PolicyEngine } from "@hobbots/permissions";
import { type HubCallRuntime, hubCallRuntimes } from "@hobbots/runtimes/testing";
import { Effect, Exit, Layer } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// The Memory tools on each runtime that serves hub tools (ADR 031, #1135): the fake runtime, and an
// installed Claude Code and Codex where HOBBOTS_CLAUDE_CODE and HOBBOTS_CODEX name them, each with a
// stand-in model. Each call's step is recorded with the turn's recorder before memory is reached.

const root = realpathSync(mkdtempSync(join(tmpdir(), "hobbots-memory-runtimes-")));
const folder = join(root, "app");
mkdirSync(folder, { recursive: true });

const access: ToolAccess = {
  policy: {
    preset: "balanced",
    sharedFolders: [],
    hob: { ...EMPTY_HOB_POLICY, ownFolders: [folder] },
    dataFolder: join(root, "data"),
    restrictions: [],
  },
  folders: [folder],
  runtimeFolder: join(root, "runtimes", "pip"),
  commitsAs: { _tag: "UserConfig", config: { name: "Ada", email: "ada@example.com" } },
};

/** A private camp (ADR 037): nothing from it is saved to memory. */
const camp = ThreadId.make("camp");

/** One hub's memory tools for a turn in `threadId`, over the in-memory store, with every record and store call in `order`. */
const memoryHub = (threadId: ThreadId | null = null) => {
  const memory = makeMemoryStoreFake();
  const saves = makeMemorySavesFake();
  const order: Array<string> = [];
  const store: MemoryStoreShape = {
    ...memory.store,
    search: (...args) =>
      Effect.andThen(
        Effect.sync(() => order.push("search")),
        memory.store.search(...args),
      ),
    write: (...args) =>
      Effect.andThen(
        Effect.sync(() => order.push("write")),
        memory.store.write(...args),
      ),
  };
  const layer = MemoryToolsLive.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(MemoryStore, store),
        Layer.succeed(MemorySaves, saves.service),
        Layer.succeed(
          MemoryProjects,
          MemoryProjects.of({
            of: () => Effect.succeed(memoryProjectIdentity(null, "app")),
            origin: () => Effect.succeed(null),
          }),
        ),
        PolicyEngine.node,
        Layer.succeed(PrivateCamps, { holds: (work) => Effect.succeed(work.threadId === camp) }),
      ),
    ),
  );
  const turn: CharmTurn = {
    agentId: AgentId.make("0d6e2f0a-0000-4000-8000-000000000001"),
    threadId,
    messageId: null,
    scope: () => "reply:m1",
    also: "reply:m1",
    currentAccess: Effect.succeed(access),
    redactor: makeRedactor([]),
    approvals: null,
  };
  const tools = Effect.runPromise(MemoryTools.use((service) => service.forTurn(turn)).pipe(Effect.provide(layer)));
  return { tools, order, saves };
};

const lesson = {
  key: "tests",
  scope: "mine",
  path: "notes/tests.md",
  markdown: "# Tests\n\nThis repository runs its tests with `pnpm test`.",
};

/** The runtimes this run covers: the fake runtime, and each installed one the environment names. */
const expectedRuntimes = [
  "fake",
  ...(process.env.HOBBOTS_CLAUDE_CODE === undefined ? [] : ["claude-code"]),
  ...(process.env.HOBBOTS_CODEX === undefined ? [] : ["codex"]),
];

let runtimes: Awaited<ReturnType<typeof hubCallRuntimes>>;
beforeAll(async () => {
  runtimes = await hubCallRuntimes();
});
afterAll(() => {
  runtimes.close();
  rmSync(root, { recursive: true, force: true });
});

/** Runs a turn on `runtime` in `threadId` that saves the lesson and searches for it, with a recorder answering `records`. */
const saveAndSearch = async (runtime: HubCallRuntime, records: boolean, threadId: ThreadId | null = null) => {
  const hub = memoryHub(threadId);
  const hubTools = await hub.tools;
  if (hubTools === null) throw new Error("No memory tools");
  const { exit } = await runtime.turn({
    hubTools,
    recordToolStart: (event) =>
      Effect.sync(() => {
        hub.order.push(`recorded ${event.tool} ${event.operation}`);
        return records;
      }),
    calls: [
      { tool: MEMORY_SAVE_TOOL, input: lesson },
      { tool: MEMORY_SEARCH_TOOL, input: { query: "pnpm test" } },
    ],
  });
  expect(Exit.isSuccess(exit), String(exit)).toBe(true);
  return { ...hub, exit };
};

describe("the Memory tools on every runtime", () => {
  // covers EX-004, ADR 028 (The memory tools), ADR 031
  it("[TC-PE-495] each runtime records a memory call's step before memory is reached, and reaches nothing unrecorded", {
    timeout: 240_000,
  }, async () => {
    expect(runtimes.runtimes.map((runtime) => runtime.name)).toEqual(expectedRuntimes);
    for (const runtime of runtimes.runtimes) {
      const recorded = await saveAndSearch(runtime, true);
      expect(recorded.order, runtime.name).toEqual([
        "recorded memory_save save-memory",
        "write",
        "recorded memory_search search-memory",
        "search",
      ]);
      const unrecorded = await saveAndSearch(runtime, false);
      expect(unrecorded.order, runtime.name).toEqual([
        "recorded memory_save save-memory",
        "recorded memory_search search-memory",
      ]);
      expect(unrecorded.saves.saves(), runtime.name).toEqual([]);
    }
  });

  // covers ADR 037 (A camp is a thread with a kind), ADR 028 (The memory tools)
  it("[TC-GEN-1377-08] each runtime's save from a private camp is refused before memory is reached, and its search still runs", {
    timeout: 240_000,
  }, async () => {
    for (const runtime of runtimes.runtimes) {
      const hub = await saveAndSearch(runtime, true, camp);
      expect(hub.order, runtime.name).toEqual(["recorded memory_search search-memory", "search"]);
      expect(hub.saves.saves(), runtime.name).toEqual([]);
      // The hob reads why: on a real runtime its model is sent the refusal.
      const told = runtime.name === "fake" ? JSON.stringify(hub.exit) : runtime.modelText().join("\n");
      expect(told, runtime.name).toContain("This camp is private");
    }
  });
});
