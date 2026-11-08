import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type PromptRequest, type RuntimeEvent, WEB_RESULTS_LINE } from "@hobbots/agents";
import { EMPTY_HOB_POLICY, type HobPolicy } from "@hobbots/domain";
import { PolicyEngine } from "@hobbots/permissions";
import { Effect, Exit, Stream } from "effect";
import { afterAll, describe, expect, it } from "vitest";
import { codexTurnEvents } from "../src/codex/events.ts";
import { type CodexTurnConfig, codexFolders, runCodexTurn } from "../src/codex/turn.ts";
import type { ProcessSandboxShape } from "../src/sandbox.ts";
import { claudeWebSearched, codexWebSearched } from "../src/web-search.ts";
import { completed, fakeServer, n, THREAD, TURN } from "./codex-app-server.ts";

// Codex's own web search, in cached mode only (ADR 036, #1266).

const temp = mkdtempSync(join(tmpdir(), "hobbots-codex-search-"));
afterAll(() => rmSync(temp, { recursive: true, force: true }));

const item = (kind: "item/started" | "item/completed", body: Record<string, unknown>) => n(kind, { item: body });
const search = (id: string, action: Record<string, unknown> | null, results: ReadonlyArray<unknown> | null = null) => ({
  type: "webSearch",
  id,
  query: "hobbots rel…",
  action,
  results,
});
const usage = (tokens: number) => {
  const breakdown = {
    totalTokens: tokens * 2,
    inputTokens: tokens,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    outputTokens: tokens,
    reasoningOutputTokens: 0,
  };
  return n("thread/tokenUsage/updated", {
    tokenUsage: { last: breakdown, total: breakdown, modelContextWindow: 200_000 },
  });
};
const HITS = [
  { title: "Hobbots releases", url: "https://example.com/releases", snippet: "The latest release." },
  { url: "https://example.com/no-title" },
  { title: "No address" },
  "a plain string",
];

describe("reading a Codex search", () => {
  // covers ADR 036
  it("[TC-RT-1266-02] shows a search as a step, reports its whole query and structured hits, and counts it", () => {
    const read = codexTurnEvents(THREAD, [], [], [], true);
    read.map(usage(0));
    expect(read.map(item("item/started", search("s1", null))).events).toEqual([
      { _tag: "StepStarted", id: "s1", kind: "tool", label: "Searching the web" },
    ]);
    const done = read.map(
      item("item/completed", search("s1", { type: "search", query: "hobbots releases", queries: ["hobbots"] }, HITS)),
    );
    expect(done.events).toEqual([
      { _tag: "StepEnded", id: "s1" },
      {
        _tag: "WebSearched",
        id: "s1",
        query: "hobbots releases; hobbots",
        results: [
          { title: "Hobbots releases", url: "https://example.com/releases", snippet: "The latest release." },
          { title: "https://example.com/no-title", url: "https://example.com/no-title" },
        ],
      },
    ]);
    expect(done.searched).toBe(true);
    // Opening a page is not a search, so it is neither reported nor counted.
    read.map(item("item/started", search("s2", null)));
    const opened = read.map(item("item/completed", search("s2", { type: "openPage", url: "https://example.com" })));
    expect(opened.events).toEqual([{ _tag: "StepEnded", id: "s2" }]);
    expect(opened.searched).toBeUndefined();
    read.map(usage(4));
    expect(read.reply()).toMatchObject({ usage: { webSearches: 1 } });
  });

  it("counts no searches on a turn that could not search, and reads a hit list Codex left empty as none", () => {
    const read = codexTurnEvents(THREAD);
    read.map(usage(0));
    read.map(usage(4));
    expect(read.reply()).not.toHaveProperty("usage.webSearches");
    expect(codexWebSearched({ id: "s", query: "short", action: { type: "search" }, results: [] })).toEqual({
      _tag: "WebSearched",
      id: "s",
      query: "short",
      results: null,
    });
    expect(codexWebSearched({ id: "s", action: null })).toBeUndefined();
  });

  it("reads Claude Code's WebSearch result from its structured record, never from its text", () => {
    const response = {
      query: "hobbots releases",
      results: [
        "I found these.",
        { tool_use_id: "srv", content: [{ title: "Releases", url: "https://example.com/r" }, "https://example.com/x"] },
      ],
      durationSeconds: 1,
    };
    expect(claudeWebSearched("t1", { query: "ignored" }, response)).toEqual({
      _tag: "WebSearched",
      id: "t1",
      query: "hobbots releases",
      results: [{ title: "Releases", url: "https://example.com/r" }],
    });
    expect(claudeWebSearched("t2", { query: "from the input" }, "not structured")).toEqual({
      _tag: "WebSearched",
      id: "t2",
      query: "from the input",
      results: null,
    });
  });
});

describe("a Codex turn that may search the web", () => {
  const setup = async (server: ReturnType<typeof fakeServer>, hob: HobPolicy = EMPTY_HOB_POLICY) => {
    const root = realpathSync(mkdtempSync(join(temp, "turn-")));
    const project = join(root, "project");
    mkdirSync(project);
    const binary = join(root, "codex");
    writeFileSync(binary, "");
    const engine = await Effect.runPromise(Effect.service(PolicyEngine).pipe(Effect.provide(PolicyEngine.node)));
    const sandbox: ProcessSandboxShape = {
      state: "on",
      evidence: "a stand-in sandbox",
      prepare: () => Effect.succeed({ spawnArgs: (command, args, env) => ({ command, args, env }), release: () => {} }),
    };
    const runtimeFolder = join(root, "runtimes", "hob-1");
    const tools = {
      policy: { preset: "balanced", sharedFolders: [project], hob, dataFolder: join(root, "data"), restrictions: [] },
      folders: [project],
      runtimeFolder,
      commitsAs: { _tag: "UserConfig", config: { name: "Ada", email: "ada@example.com" } },
    } as const;
    const turnConfig: CodexTurnConfig = {
      binary: Effect.succeed(binary),
      start: server.start,
      signIn: () => Effect.succeed(null),
      clientVersion: "0.0.0",
      workspaceDir: mkdtempSync(join(temp, "w-")),
      userHome: join(temp, "home"),
      policy: { engine, sandboxState: "on", sandbox },
    };
    const request: PromptRequest = {
      prompt: "What is new in Hobbots?",
      sessionId: null,
      instructions: "Be brief.",
      instructionsChanged: false,
      model: null,
      effort: null,
      tools,
      webSearch: true,
    };
    const settings = () => readFileSync(join(codexFolders(runtimeFolder).home, "config.toml"), "utf8");
    return { turnConfig, request, settings };
  };
  const run = (turnConfig: CodexTurnConfig, request: PromptRequest) =>
    Effect.runPromise(Stream.runCollect(runCodexTurn(turnConfig, request)).pipe(Effect.exit));
  const events = (exit: Exit.Exit<ReadonlyArray<RuntimeEvent>, unknown>) => (Exit.isSuccess(exit) ? exit.value : []);
  const searchingTurn = () =>
    fakeServer({
      script: [
        n("turn/started", { turn: { id: TURN } }),
        usage(0),
        item("item/started", search("s1", null)),
        item("item/completed", search("s1", { type: "search", query: "hobbots releases" }, HITS.slice(0, 1))),
        item("item/completed", { type: "agentMessage", id: "m1", text: "Version 1 is out." }),
        usage(4),
        completed("completed"),
      ],
    });

  // covers ADR 036
  it("[TC-RT-1266-03] offers cached search on a held Codex, labels the results as other people's text and counts them", async () => {
    const server = searchingTurn();
    const { turnConfig, request, settings } = await setup(server);
    const exit = await run({ ...turnConfig, cachedSearch: Effect.succeed(true) }, request);
    expect(Exit.isSuccess(exit)).toBe(true);
    expect(settings()).toContain('web_search = "cached"');
    expect(settings()).not.toMatch(/web_search = "(live|indexed)"/);
    expect(events(exit)).toContainEqual({
      _tag: "WebSearched",
      id: "s1",
      query: "hobbots releases",
      results: [{ title: "Hobbots releases", url: "https://example.com/releases", snippet: "The latest release." }],
    });
    expect(server.requests.filter((asked) => asked.method === "turn/steer")).toEqual([
      {
        method: "turn/steer",
        params: {
          threadId: THREAD,
          expectedTurnId: TURN,
          input: [{ type: "text", text: WEB_RESULTS_LINE, text_elements: [] }],
        },
      },
    ]);
    expect(events(exit).at(-1)).toMatchObject({ _tag: "Completed", usage: { webSearches: 1 } });
  });

  // covers ADR 036
  it("[TC-RT-1266-04] turns Codex's search off on a Codex the contract test did not hold, and for a hob set to Never", async () => {
    const unheld = await setup(fakeServer({ script: [completed("completed")] }));
    await run(unheld.turnConfig, unheld.request);
    expect(unheld.settings()).toContain('web_search = "disabled"');

    const never = { ...EMPTY_HOB_POLICY, overrides: { "search-web": "deny" } } as const;
    const refused = await setup(fakeServer({ script: [completed("completed")] }), never);
    await run({ ...refused.turnConfig, cachedSearch: Effect.succeed(true) }, refused.request);
    expect(refused.settings()).toContain('web_search = "disabled"');

    // A turn the hub did not let search does not either, whatever the version.
    const unasked = await setup(fakeServer({ script: [completed("completed")] }));
    await run({ ...unasked.turnConfig, cachedSearch: Effect.succeed(true) }, { ...unasked.request, webSearch: false });
    expect(unasked.settings()).toContain('web_search = "disabled"');
  });
});
