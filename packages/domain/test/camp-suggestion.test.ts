import { Schema } from "effect";
import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  CAMP_SUGGESTION_ARTIFACTS,
  CAMP_SUGGESTION_DECISIONS,
  CAMP_SUGGESTION_MESSAGES,
  CAMP_SUGGESTION_QUESTS,
  CampSuggestion,
  type CampSuggestionEvent,
  CampSuggestionId,
  CampSuggestionRefused,
  CampSuggestionStateMachine,
  CampSuggestions,
  Chapter,
  ChapterId,
  campSuggestionReasons,
  IllegalSuggestionTransition,
  planCampSuggestion,
  planKeep,
  type SuggestionState,
  suggestedCampGoal,
  suggestedCampTitle,
  ChannelId,
} from "../src/index.ts";
import { agreesWithModel } from "../testing/machine-model.ts";

// Issue #1385 (ADR 037, Records: CampSuggestion): a suggestion is open, kept, accepted or expired,
// changes only once, and is raised by a pure rule at most once per chapter, from named thresholds.
// Issue #1557: it is raised pending, then offered with a name and goal, or withdrawn.

const CHAT = ChannelId.make("chat-1");
const CAMP = ChannelId.make("camp-1");
const CHAPTER = ChapterId.make("chapter-1");
const at = (minute: number) => new Date(Date.UTC(2026, 10, 12) + minute * 60_000).toISOString();

const suggestion = (state: SuggestionState = "open") =>
  new CampSuggestion({
    id: CampSuggestionId.make("s1"),
    channelId: CHAT,
    chapterId: CHAPTER,
    reasons: [{ code: "decisions", count: CAMP_SUGGESTION_DECISIONS }],
    title: state === "pending" ? null : "Launch",
    goal: null,
    state,
    raisedAt: at(0),
    settledAt: state === "open" || state === "pending" ? null : at(1),
    campId: state === "accepted" ? CAMP : null,
  });

/** What the model tracks of a suggestion: every field a rule writes. */
interface SuggestionView {
  readonly state: SuggestionState;
  readonly settledAt: string | null;
  readonly campId: string | null;
  readonly title: string | null;
  readonly goal: string | null;
}

const view = (s: CampSuggestion): SuggestionView => ({
  state: s.state,
  settledAt: s.settledAt,
  campId: s.campId,
  title: s.title,
  goal: s.goal,
});

// ADR 037's rule, kept apart from the machine: a pending suggestion is offered with its name and goal
// or withdrawn; an open one is kept; either one is accepted or expired, once, and never accepted into
// the chat it was raised in.
const step = (m: SuggestionView, e: CampSuggestionEvent): SuggestionView | "refused" => {
  const unsettled = m.state === "pending" || m.state === "open";
  switch (e._tag) {
    case "Offer":
      return m.state === "pending" ? { ...m, state: "open", title: e.title, goal: e.goal } : "refused";
    case "Withdraw":
      return m.state === "pending" ? { ...m, state: "expired", settledAt: e.at } : "refused";
    case "Keep":
      return m.state === "open" ? { ...m, state: "kept", settledAt: e.at } : "refused";
    case "Accept":
      return !unsettled || e.campId === CHAT
        ? "refused"
        : { ...m, state: "accepted", settledAt: e.at, campId: e.campId };
    case "Expire":
      return unsettled ? { ...m, state: "expired", settledAt: e.at } : "refused";
    default:
      return "refused";
  }
};

const times = fc.integer({ min: 0, max: 10_000 }).map(at);
const words = fc.option(fc.constantFrom("Launch", "The garden"), { nil: null });
const events: fc.Arbitrary<CampSuggestionEvent> = fc.oneof(
  fc.record({ _tag: fc.constant("Offer" as const), title: words, goal: words }),
  fc.record({ _tag: fc.constant("Withdraw" as const), at: times }),
  fc.record({ _tag: fc.constant("Keep" as const), at: times }),
  fc.record({ _tag: fc.constant("Expire" as const), at: times }),
  fc.record({ _tag: fc.constant("Accept" as const), at: times, campId: fc.constantFrom(CHAT, CAMP) }),
);

describe("CampSuggestionStateMachine", () => {
  it("agrees with a model of offering, keeping, accepting and expiring over random runs of events (#1385)", () => {
    agreesWithModel({
      machine: CampSuggestionStateMachine,
      records: fc.constantFrom<SuggestionState>("pending", "open", "kept", "accepted", "expired").map(suggestion),
      events,
      model: { init: view, step, view },
      isError: (result): result is IllegalSuggestionTransition => result instanceof IllegalSuggestionTransition,
    });
  });

  it("exports one row per event", () => {
    expect(CampSuggestionStateMachine.table.map((row) => [row.event, row.from, row.to, row.guarded])).toEqual([
      ["Offer", ["pending"], "open", false],
      ["Withdraw", ["pending"], "expired", false],
      ["Keep", ["open"], "kept", false],
      ["Accept", ["pending", "open"], "accepted", true],
      ["Expire", ["pending", "open"], "expired", false],
    ]);
  });

  it("keeps a suggestion once and answers Keep again as it is, and refuses one settled otherwise", () => {
    const kept = planKeep(CampSuggestionId.make("s1"), suggestion(), at(2));
    expect(kept).toMatchObject({ changed: true, kept: { state: "kept", settledAt: at(2) } });
    expect(planKeep(CampSuggestionId.make("s1"), suggestion("kept"), at(3))).toMatchObject({ changed: false });
    expect(planKeep(CampSuggestionId.make("s1"), suggestion("accepted"), at(3))).toEqual(
      new CampSuggestionRefused({ suggestionId: CampSuggestionId.make("s1"), reason: "settled" }),
    );
    expect(planKeep(CampSuggestionId.make("s2"), null, at(3))).toEqual(
      new CampSuggestionRefused({ suggestionId: CampSuggestionId.make("s2"), reason: "not-found" }),
    );
    // One not offered yet is not there to keep (#1557).
    expect(planKeep(CampSuggestionId.make("s1"), suggestion("pending"), at(3))).toEqual(
      new CampSuggestionRefused({ suggestionId: CampSuggestionId.make("s1"), reason: "not-found" }),
    );
    expect(CampSuggestions.isOpen(suggestion())).toBe(true);
    expect(CampSuggestions.isOpen(suggestion("kept"))).toBe(false);
  });
});

const counts = (fields: Partial<Parameters<typeof campSuggestionReasons>[0]> = {}) => ({
  decisions: 0,
  artifacts: 0,
  quests: 0,
  messages: 0,
  ...fields,
});

describe("the suggestion rule", () => {
  it("reaches each named threshold at its value and not one below (#1385)", () => {
    const cases = [
      ["decisions", "decisions", CAMP_SUGGESTION_DECISIONS],
      ["artifacts", "artifacts", CAMP_SUGGESTION_ARTIFACTS],
      ["quests", "quests", CAMP_SUGGESTION_QUESTS],
      ["messages", "length", CAMP_SUGGESTION_MESSAGES],
    ] as const;
    for (const [field, code, threshold] of cases) {
      expect(campSuggestionReasons(counts({ [field]: threshold - 1 }))).toEqual([]);
      expect(campSuggestionReasons(counts({ [field]: threshold }))).toEqual([{ code, count: threshold }]);
    }
    expect(
      campSuggestionReasons(counts({ decisions: CAMP_SUGGESTION_DECISIONS + 2, messages: CAMP_SUGGESTION_MESSAGES })),
    ).toEqual([
      { code: "decisions", count: CAMP_SUGGESTION_DECISIONS + 2 },
      { code: "length", count: CAMP_SUGGESTION_MESSAGES },
    ]);
  });

  it("raises a suggestion only in an open chat, for a chapter still in it, once (#1385)", () => {
    const chapter = new Chapter({
      id: CHAPTER,
      channelId: CHAT,
      number: 1,
      title: null,
      summary: null,
      state: "live",
      startedAt: at(0),
      endedAt: null,
      movedTo: null,
    });
    const facts = {
      channel: { id: CHAT, openChat: true },
      chapter,
      suggested: false,
      reasons: [{ code: "quests" as const, count: CAMP_SUGGESTION_QUESTS }],
      id: CampSuggestionId.make("s9"),
      at: at(4),
    };
    expect(planCampSuggestion(facts)).toMatchObject({
      id: "s9",
      state: "pending",
      chapterId: CHAPTER,
      raisedAt: at(4),
      title: null,
      goal: null,
    });
    expect(planCampSuggestion({ ...facts, suggested: true })).toBeNull();
    expect(planCampSuggestion({ ...facts, reasons: [] })).toBeNull();
    expect(planCampSuggestion({ ...facts, channel: { id: CHAT, openChat: false } })).toBeNull();
    expect(
      planCampSuggestion({ ...facts, chapter: new Chapter({ ...chapter, state: "moved", movedTo: CAMP }) }),
    ).toBeNull();
  });
});

describe("a suggested camp's name and goal", () => {
  // covers ADR 037 (Records: CampSuggestion), #1557
  it("keeps them to one line, within a channel title's and a camp goal's length, and none without text (#1557)", () => {
    expect(suggestedCampTitle("  The\n launch  ")).toBe("The launch");
    expect(suggestedCampTitle("x".repeat(80))).toHaveLength(60);
    expect(suggestedCampTitle(" \n ")).toBeNull();
    expect(suggestedCampGoal("Ship the launch\nby Friday")).toBe("Ship the launch by Friday");
    expect(suggestedCampGoal("y".repeat(600))).toHaveLength(500);
    expect(suggestedCampGoal("")).toBeNull();
  });

  it("decodes a suggestion stored before them with neither", () => {
    const { title: _title, goal: _goal, ...stored } = Schema.encodeSync(CampSuggestion)(suggestion("open"));
    expect(Schema.decodeUnknownSync(CampSuggestion)(stored)).toMatchObject({ title: null, goal: null });
  });
});
