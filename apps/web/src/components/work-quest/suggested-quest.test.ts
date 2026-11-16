import { describe, expect, it } from "vitest";
import { questSuggestion } from "./suggested-quest.tsx";

describe("questSuggestion", () => {
  // covers ADR 041 (Starting)
  it("reads the Quest a start_work request suggests, and nothing from any other request (#1597)", () => {
    const suggested = {
      title: "Winter market page",
      goal: "A landing page for the winter market.",
      done_when: ["The page is live", "It shows the map"],
      expected_by: "2026-12-01",
    };
    expect(questSuggestion({ tool: "start_work", arguments: suggested })).toEqual({
      title: "Winter market page",
      goal: "A landing page for the winter market.",
      doneWhen: ["The page is live", "It shows the map"],
      expectedBy: "2026-12-01",
    });
    const { expected_by: _, ...undated } = suggested;
    expect(questSuggestion({ tool: "start_work", arguments: undated })?.expectedBy).toBeNull();
    expect(
      questSuggestion({ tool: "start_work", arguments: { ...suggested, done_when: "The page is live" } }),
    ).toBeNull();
    expect(questSuggestion({ tool: "read_hob", arguments: suggested })).toBeNull();
  });
});
