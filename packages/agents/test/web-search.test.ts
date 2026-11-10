import { AgentId, DEFAULT_WEB_SETTINGS, EMPTY_HOB_POLICY, type HobPolicy, MessageId, ThreadId } from "@hobbots/domain";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
  narrows,
  pageSearchReason,
  type ToolAccess,
  turnWebSearch,
  WebRecords,
  webSearchRequest,
  webSearchTurn,
} from "../src/index.ts";

// Search the web (ADR 036): the hub settles whether a turn may search, and narrowing it stops a running turn.

const access = (
  overrides: HobPolicy["overrides"] = {},
  preset: ToolAccess["policy"]["preset"] = "balanced",
): ToolAccess => ({
  policy: {
    preset,
    sharedFolders: ["/work"],
    hob: { ...EMPTY_HOB_POLICY, overrides },
    dataFolder: "/data",
    restrictions: [],
  },
  folders: ["/work"],
  runtimeFolder: "/runtimes/hob",
  commitsAs: { _tag: "UserConfig", config: { name: "Ada", email: "ada@example.com" } },
});

describe("Search the web", () => {
  // covers PE-008, ADR 036
  it("[TC-PE-1266-02] stops a running turn when Search the web is set to Never, not when it is allowed again", () => {
    expect(narrows(access(), access({ "search-web": "deny" }))).toBe(true);
    expect(narrows(access({ "search-web": "deny" }), access())).toBe(false);
  });

  it("lets a turn search only with tools and an Allow answer", () => {
    for (const searchOpensPages of [false, true]) {
      expect(turnWebSearch(access(), { searchOpensPages })).toBe(true);
      expect(turnWebSearch(access({ "search-web": "deny" }), { searchOpensPages })).toBe(false);
      expect(turnWebSearch(null, { searchOpensPages })).toBe(false);
    }
  });

  // covers ADR 036, STD-SEC-002
  it("[TC-PE-523] offers a search that can open pages only where Use the web reads any page without asking", () => {
    const opensPages = { searchOpensPages: true };
    const linksOnly = { searchOpensPages: false };
    // Careful asks before the first page on a new site, and Never refuses every page.
    for (const narrowed of [access({}, "careful"), access({ "use-web": "ask" }), access({ "use-web": "deny" })]) {
      expect(turnWebSearch(narrowed, opensPages)).toBe(false);
      expect(turnWebSearch(narrowed, linksOnly)).toBe(true);
    }
    expect(turnWebSearch(access(), opensPages)).toBe(true);
    expect(turnWebSearch(access({}, "trusting"), opensPages)).toBe(true);
    // A runtime that does not say what its search does is taken to open pages.
    expect(turnWebSearch(access({}, "careful"), {})).toBe(false);
  });
});

const place = {
  agentId: AgentId.make("ada"),
  threadId: ThreadId.make("t1"),
  messageId: MessageId.make("m1"),
  runtime: "codex",
  work: "thread:t1",
  taskId: Effect.succeed(null),
  attemptId: Effect.succeed(null),
} as const;

const requestUnder = (settings: typeof DEFAULT_WEB_SETTINGS, policy: ToolAccess, searchOpensPages: boolean) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* (yield* WebRecords).setSettings(settings);
      return webSearchRequest(policy, yield* webSearchTurn(place), { searchOpensPages });
    }).pipe(Effect.provide(WebRecords.memory)),
  );

describe("a turn's search where the runtime's search opens pages", () => {
  // covers ADR 036, STD-SEC-002
  it("[TC-PE-524] turns it off under Careful, a blocked site or no pages a turn, and tells the hob why", async () => {
    const careful = await requestUnder(DEFAULT_WEB_SETTINGS, access({}, "careful"), true);
    expect(careful).toMatchObject({ webSearch: false, note: pageSearchReason.useWeb });

    const blocked = { ...DEFAULT_WEB_SETTINGS, blockedSites: ["example.org"] };
    expect(await requestUnder(blocked, access(), true)).toMatchObject({
      webSearch: false,
      note: pageSearchReason.blockedSites,
    });
    const noPages = { ...DEFAULT_WEB_SETTINGS, limits: { ...DEFAULT_WEB_SETTINGS.limits, pagesPerTurn: 0 } };
    expect(await requestUnder(noPages, access(), true)).toMatchObject({
      webSearch: false,
      note: pageSearchReason.pagesPerTurn,
    });

    // A hob set to Never for Search the web is told nothing about pages.
    expect(await requestUnder(blocked, access({ "search-web": "deny" }), true)).toMatchObject({
      webSearch: false,
      note: null,
    });
    expect(await requestUnder(DEFAULT_WEB_SETTINGS, access(), true)).toMatchObject({ webSearch: true, note: null });
  });

  // covers ADR 036
  it("keeps a search that returns links only on under Careful and with blocked sites", async () => {
    const blocked = { ...DEFAULT_WEB_SETTINGS, blockedSites: ["example.org"] };
    expect(await requestUnder(blocked, access({}, "careful"), false)).toMatchObject({ webSearch: true, note: null });
  });
});
