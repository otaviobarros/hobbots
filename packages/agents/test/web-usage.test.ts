import {
  AgentId,
  AttemptId,
  blockedSiteFor,
  DEFAULT_WEB_SETTINGS,
  effectiveWebLimits,
  MessageId,
  ThreadId,
  webSearchBilledPerSearch,
} from "@hobbots/domain";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { blockedSiteOf, type RuntimeEvent, WebRecords, type WebTurnPlace, webSearchTurn } from "../src/index.ts";

// What hobs search on the web, and the limits on it (ADR 036, Usage and limits, #1269).

const ada = AgentId.make("ada");
const place = (messageId: string): WebTurnPlace => ({
  agentId: ada,
  threadId: ThreadId.make("t1"),
  messageId: MessageId.make(messageId),
  runtime: "codex",
  work: "thread:t1",
  taskId: Effect.succeed(null),
  attemptId: Effect.succeed(AttemptId.make("a1")),
});
const searched = (query: string): RuntimeEvent => ({
  _tag: "WebSearched",
  id: query,
  query,
  results: [{ title: "Lamps", url: "https://lamps.test/", snippet: "ignored" }],
});
const started: RuntimeEvent = { _tag: "SessionStarted", sessionId: "s", billing: "subscription (plus)" };
const run = <A>(effect: Effect.Effect<A, never, WebRecords>) =>
  Effect.runPromise(effect.pipe(Effect.provide(WebRecords.memory)));

describe("web limits and records", () => {
  it("keeps blocked sites as hosts, and blocks a site with every name under it", () => {
    expect(blockedSiteOf(" https://Docs.Example.com/path?q ")).toBe("docs.example.com");
    expect(blockedSiteOf("*.example.org")).toBe("example.org");
    expect(blockedSiteOf("example.net.")).toBe("example.net");
    expect(blockedSiteOf("")).toBeNull();
    expect(blockedSiteOf("not a host")).toBeNull();
    expect(blockedSiteFor("www.example.org", ["example.org"])).toBe("example.org");
    expect(blockedSiteFor("example.org", ["example.org"])).toBe("example.org");
    expect(blockedSiteFor("badexample.org", ["example.org"])).toBeNull();
  });

  it("takes a hob's own limit where it set one, Settings › Web's for the rest", () => {
    expect(
      effectiveWebLimits(DEFAULT_WEB_SETTINGS, { searchesPerTurn: 2, pagesPerTurn: null, searchesPerDay: null }),
    ).toEqual({ searchesPerTurn: 2, pagesPerTurn: 30, searchesPerDay: 200 });
  });

  it("bills a search per search only on an API key or the Claude API", () => {
    expect(webSearchBilledPerSearch("api-key (ANTHROPIC_API_KEY)")).toBe(true);
    expect(webSearchBilledPerSearch("api (Claude API)")).toBe(true);
    expect(webSearchBilledPerSearch("api-key")).toBe(true);
    for (const billing of ["subscription", "subscription (Max)", "fake", null]) {
      expect(webSearchBilledPerSearch(billing)).toBe(false);
    }
  });

  // covers ADR 036 (Usage and limits)
  it("[TC-AG-1269-01] records each search with its hob, chat, reply, Attempt, results and billing, and refuses past the turn's limit", async () => {
    const { usage, refusals } = await run(
      Effect.gen(function* () {
        const records = yield* WebRecords;
        yield* records.setHobLimits(ada, { searchesPerTurn: 1, pagesPerTurn: null, searchesPerDay: null });
        const turn = yield* webSearchTurn(place("m1"));
        expect(turn).toMatchObject({ on: true, note: null });
        const refusals = [yield* turn.check("lamps"), yield* turn.check("oil")];
        yield* turn.see(started);
        yield* turn.see(searched("lamps"));
        yield* turn.end;
        return { usage: yield* records.usage({ messageId: MessageId.make("m1") }, 10), refusals };
      }),
    );
    expect(refusals).toEqual([null, "This turn reached its limit of 1 web search, set in Settings › Web."]);
    expect(usage.count).toEqual({ searches: 1, pages: 0, bytes: 0, tokens: 0, billed: [] });
    expect(usage.searches[0]).toMatchObject({
      agentId: ada,
      threadId: "t1",
      messageId: "m1",
      attemptId: "a1",
      turn: "reply:m1",
      runtime: "codex",
      query: "lamps",
      resultCount: 1,
      results: [{ title: "Lamps", url: "https://lamps.test/" }],
      billing: "subscription (plus)",
    });
  });

  // covers ADR 036 (Usage and limits: Codex's soft per-turn limit and the daily limit)
  it("[TC-AG-1269-02] a turn over its search limit starts the session's next turn with search off, and a hob over its daily limit has search off", async () => {
    const turns = await run(
      Effect.gen(function* () {
        const records = yield* WebRecords;
        yield* records.setSettings({
          ...DEFAULT_WEB_SETTINGS,
          limits: { searchesPerTurn: 1, pagesPerTurn: 30, searchesPerDay: 3 },
        });
        // Codex cannot be stopped mid-turn: it searched twice, past the limit of one.
        const first = yield* webSearchTurn(place("m1"));
        yield* first.see(searched("a"));
        yield* first.see(searched("b"));
        yield* first.end;
        const second = yield* webSearchTurn(place("m2"));
        yield* second.end;
        const third = yield* webSearchTurn(place("m3"));
        yield* third.see(searched("c"));
        yield* third.end;
        const fourth = yield* webSearchTurn(place("m4"));
        return [first, second, third, fourth].map(({ on, note }) => ({ on, note }));
      }),
    );
    expect(turns).toEqual([
      { on: true, note: null },
      {
        on: false,
        note: "Web search is off for this turn. The last turn ran 2 web searches, past its limit of 1 set in Settings › Web.",
      },
      // The hold is for one turn.
      { on: true, note: null },
      {
        on: false,
        note: "Web search is off for this turn. This hob reached its limit of 3 web searches a day, set in Settings › Web.",
      },
    ]);
  });

  // covers ADR 036 (Usage and limits: the daily limit holds across a hob's turns)
  it("[TC-AG-1269-03] two turns of one hob running at once share its daily allowance, and a search admitted but never run gives its place back", async () => {
    const answers = await run(
      Effect.gen(function* () {
        const records = yield* WebRecords;
        yield* records.setHobLimits(ada, { searchesPerTurn: 5, pagesPerTurn: null, searchesPerDay: 2 });
        yield* webSearchTurn(place("m0")).pipe(Effect.tap((turn) => turn.see(searched("before"))));
        // A chat turn and a step of the same hob, both started with one search left today.
        const chat = yield* webSearchTurn(place("m1"));
        const step = yield* webSearchTurn({ ...place("m2"), work: "task:k1" });
        const [first, second] = yield* Effect.all([chat.check("lamps"), step.check("oil")], {
          concurrency: "unbounded",
        });
        const [winner, other] = first === null ? [chat, step] : [step, chat];
        // The admitted search never ran, so its place goes back when that turn ends.
        yield* winner.end;
        const retried = yield* other.check("wicks");
        yield* other.see(searched("wicks"));
        const fresh = yield* webSearchTurn(place("m3"));
        return { first, second, retried, after: yield* fresh.check("glass"), on: fresh.on };
      }),
    );
    const daily = "This hob reached its limit of 2 web searches a day, set in Settings › Web.";
    expect([answers.first, answers.second].filter((answer) => answer === null)).toHaveLength(1);
    expect([answers.first, answers.second]).toContain(daily);
    expect(answers.retried).toBeNull();
    expect({ on: answers.on, after: answers.after }).toEqual({ on: false, after: daily });
  });
});
