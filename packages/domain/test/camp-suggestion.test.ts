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
  ThreadId,
} from "../src/index.ts";
import { agreesWithModel } from "../testing/machine-model.ts";

// Issue #1385 (ADR 037, Records: CampSuggestion): a suggestion is open, kept, accepted or expired,
// changes only once, and is raised by a pure rule at most once per chapter, from named thresholds.

const CHAT = ThreadId.make("chat-1");
const CAMP = ThreadId.make("camp-1");
const CHAPTER = ChapterId.make("chapter-1");
const at = (minute: number) => new Date(Date.UTC(2026, 10, 12) + minute * 60_000).toISOString();

const suggestion = (state: SuggestionState = "open") =>
  new CampSuggestion({
    id: CampSuggestionId.make("s1"),
    threadId: CHAT,
    chapterId: CHAPTER,
    reasons: [{ code: "decisions", count: CAMP_SUGGESTION_DECISIONS }],
    state,
    raisedAt: at(0),
    settledAt: state === "open" ? null : at(1),
    campId: state === "accepted" ? CAMP : null,
  });

/** What the model tracks of a suggestion: every field a rule writes. */
interface SuggestionView {
  readonly state: SuggestionState;
  readonly settledAt: string | null;
  readonly campId: string | null;
}

const view = (s: CampSuggestion): SuggestionView => ({ state: s.state, settledAt: s.settledAt, campId: s.campId });

// ADR 037's rule, kept apart from the machine: only an open suggestion changes, once, and it is
// never accepted into the chat it was offered in.
const step = (m: SuggestionView, e: CampSuggestionEvent): SuggestionView | "refused" => {
  if (m.state !== "open") return "refused";
  switch (e._tag) {
    case "Keep":
      return { state: "kept", settledAt: e.at, campId: null };
    case "Accept":
      return e.campId === CHAT ? "refused" : { state: "accepted", settledAt: e.at, campId: e.campId };
    case "Expire":
      return { state: "expired", settledAt: e.at, campId: null };
  }
};

const times = fc.integer({ min: 0, max: 10_000 }).map(at);
const events: fc.Arbitrary<CampSuggestionEvent> = fc.oneof(
  fc.record({ _tag: fc.constant("Keep" as const), at: times }),
  fc.record({ _tag: fc.constant("Expire" as const), at: times }),
  fc.record({ _tag: fc.constant("Accept" as const), at: times, campId: fc.constantFrom(CHAT, CAMP) }),
);

describe("CampSuggestionStateMachine", () => {
  it("[TC-CH-1385-07] agrees with a model of keeping, accepting and expiring over random runs of events", () => {
    agreesWithModel({
      machine: CampSuggestionStateMachine,
      records: fc.constantFrom<SuggestionState>("open", "kept", "accepted", "expired").map(suggestion),
      events,
      model: { init: view, step, view },
      isError: (result): result is IllegalSuggestionTransition => result instanceof IllegalSuggestionTransition,
    });
  });

  it("exports one row per event", () => {
    expect(CampSuggestionStateMachine.table.map((row) => [row.event, row.from, row.to, row.guarded])).toEqual([
      ["Keep", ["open"], "kept", false],
      ["Accept", ["open"], "accepted", true],
      ["Expire", ["open"], "expired", false],
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
  it("[TC-CH-1385-08] reaches each named threshold at its value and not one below", () => {
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

  it("[TC-CH-1385-09] raises a suggestion only in an open chat, for a chapter still in it, once", () => {
    const chapter = new Chapter({
      id: CHAPTER,
      threadId: CHAT,
      number: 1,
      title: null,
      summary: null,
      state: "live",
      startedAt: at(0),
      endedAt: null,
      movedTo: null,
    });
    const facts = {
      thread: { id: CHAT, openChat: true },
      chapter,
      suggested: false,
      reasons: [{ code: "quests" as const, count: CAMP_SUGGESTION_QUESTS }],
      id: CampSuggestionId.make("s9"),
      at: at(4),
    };
    expect(planCampSuggestion(facts)).toMatchObject({ id: "s9", state: "open", chapterId: CHAPTER, raisedAt: at(4) });
    expect(planCampSuggestion({ ...facts, suggested: true })).toBeNull();
    expect(planCampSuggestion({ ...facts, reasons: [] })).toBeNull();
    expect(planCampSuggestion({ ...facts, thread: { id: CHAT, openChat: false } })).toBeNull();
    expect(
      planCampSuggestion({ ...facts, chapter: new Chapter({ ...chapter, state: "moved", movedTo: CAMP }) }),
    ).toBeNull();
  });
});
