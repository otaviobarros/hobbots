import type { PackPart, PackReport } from "@hobbots/domain";
import { describe, expect, it } from "vitest";
import { focusRows, trimNotes } from "./focus-rows.ts";

const part = (name: PackPart["part"], tokens: number, trimmed: PackPart["trimmed"] = null): PackPart => ({
  part: name,
  share: 1000,
  tokens,
  trimmed,
});

const report: PackReport = {
  budget: 12_000,
  tokens: 2_330,
  parts: [
    part("memory-brief", 1_200),
    part("camp-brief", 0),
    part("decisions", 0),
    part("open-work", 80),
    part("carried", 40),
    part("artifacts", 0),
    part("chapters", 10),
    part("live-chapter", 1_000, { full: 3, titlesOnly: 0, leftOut: 12, cutCharacters: 400 }),
  ],
};

describe("focusRows", () => {
  it("groups every part of the report in the chip's rows, each with its parts' sizes added up", () => {
    const rows = focusRows(report, false);
    expect(rows.map((row) => [row.group, row.parts.map((p) => p.part), row.tokens])).toEqual([
      ["always", ["memory-brief"], 1_200],
      ["here", ["camp-brief", "decisions", "open-work", "artifacts", "chapters", "live-chapter"], 1_090],
      ["carried", ["carried"], 40],
    ]);
    // Every part of the report shows, once.
    expect(rows.flatMap((row) => row.parts)).toHaveLength(report.parts.length);
  });

  it("adds the Archived row, which reads nothing, for a chat started fresh", () => {
    expect(focusRows(report, true).at(-1)).toEqual({ group: "archived", parts: [], tokens: 0 });
  });

  it("says what a trimmed part left out, and nothing for one that was not", () => {
    expect(trimNotes(null)).toEqual({ kept: null, cut: 0 });
    expect(trimNotes({ full: 3, titlesOnly: 0, leftOut: 12, cutCharacters: 400 })).toEqual({
      kept: { full: 3, titlesOnly: 0, leftOut: 12 },
      cut: 400,
    });
    // A last message cut in its middle, with nothing left out.
    expect(trimNotes({ full: 1, titlesOnly: 0, leftOut: 0, cutCharacters: 90 })).toEqual({ kept: null, cut: 90 });
  });
});
