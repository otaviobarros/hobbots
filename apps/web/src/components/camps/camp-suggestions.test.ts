import { CampSuggestion, CampSuggestionId, Chapter, ChapterId, ChannelId } from "@hobbots/domain";
import { describe, expect, it } from "vitest";
import { suggestedFrom } from "./camp-suggestions.tsx";
import { startMakeCamp } from "./make-camp-flow.ts";

// Issue #1557: Make a camp prefills the camp's name and goal a suggestion offers, and for one with
// neither, the chapter's own title, never its number.

const AT = "2026-11-14T00:00:00.000Z";
const chapter = (title: string | null) =>
  new Chapter({
    id: ChapterId.make("c1"),
    channelId: ChannelId.make("chat"),
    number: 1,
    title,
    summary: null,
    state: "live",
    startedAt: AT,
    endedAt: null,
    movedTo: null,
  });
const suggestion = (title: string | null, goal: string | null) =>
  new CampSuggestion({
    id: CampSuggestionId.make("s1"),
    channelId: ChannelId.make("chat"),
    chapterId: ChapterId.make("c1"),
    reasons: [{ code: "decisions", count: 5 }],
    title,
    goal,
    state: "open",
    raisedAt: AT,
    settledAt: null,
    campId: null,
  });

describe("a camp made from a suggestion", () => {
  // covers ADR 037 (Records: CampSuggestion), #1557
  it("prefills the name and goal the hub suggests, else the chapter's own title, never Chapter N (#1557)", () => {
    const named = suggestedFrom(suggestion("Launch plan", "Ship it by Friday."), chapter(null));
    expect(named).toMatchObject({ title: "Chapter 1", name: "Launch plan", goal: "Ship it by Friday." });
    expect(startMakeCamp(named.name, true, named.goal).draft).toEqual({
      title: "Launch plan",
      goal: "Ship it by Friday.",
      private: false,
      chapter: true,
      hobs: [],
    });
    expect(suggestedFrom(suggestion(null, null), chapter("Garden plans"))).toMatchObject({
      name: "Garden plans",
      goal: "",
    });
    expect(suggestedFrom(suggestion(null, null), chapter(null))).toMatchObject({ name: "", goal: "" });
  });
});
