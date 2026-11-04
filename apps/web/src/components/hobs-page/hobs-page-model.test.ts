import { describe, expect, it } from "vitest";
import type { HobState } from "../../lib/hob-state.ts";
import { cardLine, filterCounts, filterOf, isHobFilter, lastChat, shownCrew } from "./hobs-page-model.ts";

const crewOf = (states: ReadonlyArray<HobState>) => states.map((state, index) => ({ id: `h${index}`, state }));

describe("filterOf", () => {
  it("puts waiting and trouble under Need you, thinking under Working and paused under Resting", () => {
    expect(filterOf("needs-you")).toBe("needs");
    expect(filterOf("waiting")).toBe("needs");
    expect(filterOf("failed")).toBe("needs");
    expect(filterOf("working")).toBe("working");
    expect(filterOf("thinking")).toBe("working");
    expect(filterOf("idle")).toBe("resting");
    expect(filterOf("asleep")).toBe("resting");
    expect(filterOf("paused")).toBe("resting");
  });
});

describe("filterCounts", () => {
  it("counts every hob once under All and once under its own filter", () => {
    const crew = crewOf(["needs-you", "working", "thinking", "idle", "paused", "idle"]);
    expect(filterCounts(crew)).toEqual({ all: 6, needs: 1, working: 2, resting: 3 });
  });

  it("holds with 24 hobs", () => {
    const states: ReadonlyArray<HobState> = ["working", "idle", "needs-you", "idle", "thinking", "paused"];
    const crew = crewOf(Array.from({ length: 24 }, (_, i) => states[i % states.length] ?? "idle"));
    const counts = filterCounts(crew);
    expect(counts).toEqual({ all: 24, needs: 4, working: 8, resting: 12 });
    expect(counts.needs + counts.working + counts.resting).toBe(counts.all);
  });
});

describe("shownCrew", () => {
  it("keeps the order and leaves out the hobs the filter does not show", () => {
    const crew = crewOf(["idle", "working", "needs-you", "thinking"]);
    expect(shownCrew(crew, "all")).toEqual(crew);
    expect(shownCrew(crew, "working").map((m) => m.id)).toEqual(["h1", "h3"]);
    expect(shownCrew(crew, "needs").map((m) => m.id)).toEqual(["h2"]);
  });
});

describe("lastChat", () => {
  it("picks the chat updated last, whatever the list order", () => {
    const older = { id: "a", updatedAt: "2026-11-01T10:00:00.000Z" };
    const newer = { id: "b", updatedAt: "2026-11-03T10:00:00.000Z" };
    expect(lastChat([older, newer])).toBe(newer);
    expect(lastChat([newer, older])).toBe(newer);
    expect(lastChat([])).toBeUndefined();
  });
});

describe("isHobFilter", () => {
  it("takes only the page's filters", () => {
    expect(isHobFilter("needs")).toBe(true);
    expect(isHobFilter("all")).toBe(true);
    expect(isHobFilter("paused")).toBe(false);
    expect(isHobFilter(undefined)).toBe(false);
  });
});

describe("cardLine", () => {
  const chat = (updatedAt: string, lastLine: string | null) => ({ updatedAt, lastLine });
  it("says what the hob is doing first", () => {
    expect(cardLine({ kind: "live", text: "Writing “Plan”" }, [chat("2026-11-01", "Done.")])).toBe("Writing “Plan”");
  });
  it("then the last line of its latest chat", () => {
    expect(cardLine(null, [chat("2026-11-01", "Older"), chat("2026-11-03", "Sent the report.")])).toBe(
      "Sent the report.",
    );
  });
  it("says it just arrived with no chats, and rests when its latest chat has no line yet", () => {
    expect(cardLine(null, [])).toBe("Just arrived");
    expect(cardLine(null, [chat("2026-11-03", null)])).toBe("Resting");
  });
});
