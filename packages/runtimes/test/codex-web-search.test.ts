import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type HubTools, type PromptRequest, type RuntimeEvent, WEB_RESULTS_LINE } from "@hobbots/agents";
import { EMPTY_HOB_POLICY, type HobPolicy } from "@hobbots/domain";
import { PolicyEngine } from "@hobbots/permissions";
import { Effect, Exit, Stream } from "effect";
import { afterAll, describe, expect, it } from "vitest";
import { codexTurnEvents } from "../src/codex/events.ts";
import { type CodexTurnConfig, codexFolders, runCodexTurn } from "../src/codex/turn.ts";
import type { ProcessSandboxShape } from "../src/sandbox.ts";
import { CODEX_SEARCH_PAGE, claudeWebSearched, codexWebSearched } from "../src/web-search.ts";
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
  const setup = async (
    server: ReturnType<typeof fakeServer>,
    hob: HobPolicy = EMPTY_HOB_POLICY,
    root = realpathSync(mkdtempSync(join(temp, "turn-"))),
  ) => {
    const project = join(root, "project");
    mkdirSync(project, { recursive: true });
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
    // Whether the App Server the turn started was told to search, on its own command line.
    const searches = () => server.commands.at(-1)?.args.join(" ").includes('web_search="cached"') === true;
    return { turnConfig, request, settings, searches };
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
    const { turnConfig, request, settings, searches } = await setup(server);
    const exit = await run({ ...turnConfig, cachedSearch: Effect.succeed(true) }, request);
    expect(Exit.isSuccess(exit)).toBe(true);
    expect(searches()).toBe(true);
    // The hob's shared home keeps search off, and never names live or indexed search.
    expect(settings()).toContain('web_search = "disabled"');
    expect(settings()).not.toMatch(/web_search = "(live|indexed|cached)"/);
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
  it("[TC-RT-1289-04] records a search's results with the turn's recorder before a hub call Codex sent after it runs", async () => {
    const order: Array<string> = [];
    const server = fakeServer({
      script: [
        n("turn/started", { turn: { id: TURN } }),
        item("item/completed", search("s1", { type: "search", query: "hobbots releases" }, HITS.slice(0, 1))),
        // Another thread's search is not this turn's.
        {
          method: "item/completed",
          params: { threadId: "other", turnId: TURN, item: search("s2", { type: "search" }) },
        },
        item("item/completed", { type: "agentMessage", id: "m1", text: "Read it." }),
        completed("completed"),
      ],
      asksAfter: 3,
      asks: [
        {
          method: "item/tool/call",
          params: {
            threadId: THREAD,
            turnId: TURN,
            callId: "c1",
            namespace: null,
            tool: "web_fetch",
            arguments: { url: "https://example.com/releases" },
          },
        },
      ],
    });
    const { turnConfig, request } = await setup(server);
    const hubTools: HubTools = {
      tools: [{ name: "web_fetch", description: "Reads a page.", inputSchema: { type: "object" }, label: "Reading" }],
      call: () =>
        Effect.sync(() => {
          order.push("web_fetch");
          return { text: "A page.", refused: false };
        }),
    };
    const exit = await run(
      { ...turnConfig, cachedSearch: Effect.succeed(true) },
      {
        ...request,
        hubTools,
        // Slow on purpose, as a found set written to a busy database would be.
        recordSearch: (event) =>
          Effect.sleep("100 millis").pipe(Effect.andThen(Effect.sync(() => order.push(`found ${event.id}`)))),
      },
    );
    expect(Exit.isSuccess(exit), String(exit)).toBe(true);
    expect(order).toEqual(["found s1", "web_fetch"]);
  });

  // covers ADR 036
  it("[TC-RT-1266-04] turns Codex's search off on a Codex the contract test did not hold, and for a hob set to Never", async () => {
    const unheld = await setup(fakeServer({ script: [completed("completed")] }));
    await run(unheld.turnConfig, unheld.request);
    expect(unheld.searches()).toBe(false);
    expect(unheld.settings()).toContain('web_search = "disabled"');

    const never = { ...EMPTY_HOB_POLICY, overrides: { "search-web": "deny" } } as const;
    const refused = await setup(fakeServer({ script: [completed("completed")] }), never);
    await run({ ...refused.turnConfig, cachedSearch: Effect.succeed(true) }, refused.request);
    expect(refused.searches()).toBe(false);
    expect(refused.settings()).toContain('web_search = "disabled"');

    // A turn the hub did not let search does not either, whatever the version.
    const unasked = await setup(fakeServer({ script: [completed("completed")] }));
    await run({ ...unasked.turnConfig, cachedSearch: Effect.succeed(true) }, { ...unasked.request, webSearch: false });
    expect(unasked.searches()).toBe(false);
    expect(unasked.settings()).toContain('web_search = "disabled"');
  });

  // covers ADR 036, STD-SEC-002
  it("[TC-RT-1266-12] keeps a turn under Never from searching while another turn of the hob that may search starts beside it", async () => {
    const root = realpathSync(mkdtempSync(join(temp, "shared-")));
    const never = { ...EMPTY_HOB_POLICY, overrides: { "search-web": "deny" } } as const;
    const allowed = await setup(fakeServer({ script: [completed("completed")] }), EMPTY_HOB_POLICY, root);
    const restricted = await setup(fakeServer({ script: [completed("completed")] }), never, root);
    const held = Effect.succeed(true);
    // Both start at once in the hob's one Codex home, in either order.
    for (const pair of [
      [allowed, restricted],
      [restricted, allowed],
    ] as const) {
      await Promise.all(pair.map((turn) => run({ ...turn.turnConfig, cachedSearch: held }, turn.request)));
      expect(allowed.searches()).toBe(true);
      expect(restricted.searches()).toBe(false);
      expect(restricted.settings()).toContain('web_search = "disabled"');
    }
  });

  // covers ADR 036, STD-SEC-002
  it("[TC-RT-535] keeps Codex's search off where Use the web asks first or is Never, since its search can open pages", async () => {
    for (const hob of [
      { ...EMPTY_HOB_POLICY, overrides: { "use-web": "ask" } },
      { ...EMPTY_HOB_POLICY, overrides: { "use-web": "deny" } },
    ] as const) {
      const turn = await setup(fakeServer({ script: [completed("completed")] }), hob);
      // Even where the hub asked for search, the adapter checks the page rules itself.
      await run({ ...turn.turnConfig, cachedSearch: Effect.succeed(true) }, turn.request);
      expect(turn.searches()).toBe(false);
      expect(turn.settings()).toContain('web_search = "disabled"');
    }
  });

  // covers ADR 036
  it("[TC-RT-536] marks the session as having read the web when Codex's search opens a page, without finding its URL", async () => {
    const server = fakeServer({
      script: [
        n("turn/started", { turn: { id: TURN } }),
        item("item/completed", search("s1", { type: "openPage", url: "https://example.com/written" })),
        item("item/completed", search("s2", { type: "findInPage", url: null, pattern: "release" })),
        item("item/completed", { type: "agentMessage", id: "m1", text: "Read it." }),
        completed("completed"),
      ],
    });
    const { turnConfig, request } = await setup(server);
    const reads: Array<unknown> = [];
    const found: Array<unknown> = [];
    const exit = await run(
      { ...turnConfig, cachedSearch: Effect.succeed(true) },
      {
        ...request,
        recordSearch: (event) => Effect.sync(() => void found.push(event)),
        approvals: {
          request: null,
          currentAccess: Effect.succeed(request.tools ?? null),
          grants: Effect.succeed([]),
          used: () => Effect.void,
          webMark: { current: Effect.succeed(null), read: (read) => Effect.sync(() => void reads.push(read)) },
        },
      },
    );
    expect(Exit.isSuccess(exit), String(exit)).toBe(true);
    expect(reads).toEqual([
      { _tag: "Page", url: "https://example.com/written" },
      { _tag: "Page", url: CODEX_SEARCH_PAGE },
    ]);
    // An opened page is not a search, so nothing is found or counted.
    expect(found).toEqual([]);
    expect(events(exit).filter((event) => event._tag === "WebSearched")).toEqual([]);
  });
});
