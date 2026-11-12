import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { Brief, type BriefDraft, briefChange, briefSourceOf, HUB_ACTOR, ThreadId } from "../src/index.ts";

// Issue #1384 (ADR 037, Records): a brief is rewritten by the hub's projector. A draft from no
// further along the journal than the stored brief never writes, a failed brain never replaces a
// brief already there, and a draft saying the same writes nothing.

const THREAD = ThreadId.make("camp-1");
const NOW = "2026-11-12T00:00:00.000Z";

const brief = (fields: Partial<Brief> = {}) =>
  new Brief({
    threadId: THREAD,
    text: "Launch emails go out on Tuesdays.",
    writtenBy: HUB_ACTOR,
    source: "brain",
    basis: 10,
    writtenAt: NOW,
    ...fields,
  });

const draft = (fields: Partial<BriefDraft> = {}): BriefDraft => ({
  threadId: THREAD,
  text: "Launch emails go out on Wednesdays.",
  basis: 20,
  source: "brain",
  ...fields,
});

describe("a brief's rewrite rule", () => {
  it("writes the first brief, whoever wrote its text", () => {
    expect(briefChange(null, draft())).toBe("write");
    expect(briefChange(null, draft({ source: "rule" }))).toBe("write");
    // With no brief yet, the rule's text stands in for a brain that failed, so a brief still appears.
    expect(briefChange(null, draft({ source: "fallback" }))).toBe("write");
    expect(briefSourceOf(draft({ source: "fallback" }))).toBe("rule");
    // With nothing to say and no brief yet, nothing is written.
    expect(briefChange(null, draft({ text: "" }))).toBe("unchanged");
  });

  it("writes nothing from as far along the journal as the stored brief, or less", () => {
    expect(briefChange(brief(), draft({ basis: 10 }))).toBe("stale");
    expect(briefChange(brief(), draft({ basis: 3 }))).toBe("stale");
  });

  it("keeps the last brief when the brain failed, and writes nothing that says the same", () => {
    expect(briefChange(brief(), draft({ source: "fallback" }))).toBe("kept");
    expect(briefChange(brief(), draft({ text: brief().text }))).toBe("unchanged");
    // The same words from the rule replace the brain's, so the brief says who wrote it.
    expect(briefChange(brief(), draft({ text: brief().text, source: "rule" }))).toBe("write");
  });

  it("replaces a brief the rule wrote with the rule's new text, an empty one included, even on a fallback", () => {
    const plain = brief({ source: "rule" });
    expect(briefChange(plain, draft({ source: "fallback", text: "Made:\n- launch.md (doc, version 1)" }))).toBe(
      "write",
    );
    // The last decision it named was crossed out: the brief is cleared, not kept.
    expect(briefChange(plain, draft({ source: "fallback", text: "" }))).toBe("write");
    expect(briefChange(plain, draft({ source: "rule", text: "" }))).toBe("write");
    expect(briefChange(brief({ source: "rule", text: "" }), draft({ source: "rule", text: "" }))).toBe("unchanged");
  });

  // A store of one brief, rewritten only through the rule, by drafts in journal order, as the
  // projector reads pages.
  it("on random drafts, a brief only moves forward along the journal, and a replay writes nothing", () => {
    const drafts = fc
      .array(
        fc.record({
          text: fc.constantFrom("a", "b", "c", ""),
          basis: fc.integer({ min: 0, max: 30 }),
          source: fc.constantFrom("brain" as const, "rule" as const, "fallback" as const),
        }),
        { maxLength: 30 },
      )
      .map((each) => [...each].sort((a, b) => a.basis - b.basis));
    fc.assert(
      fc.property(drafts, (made) => {
        let stored: Brief | null = null;
        const apply = (each: ReadonlyArray<(typeof made)[number]>) => {
          let writes = 0;
          for (const fields of each) {
            const next = draft(fields);
            const before: Brief | null = stored;
            const change = briefChange(before, next);
            if (change !== "write") continue;
            if (before !== null) {
              expect(next.basis).toBeGreaterThan(before.basis);
              // A fallback never replaces what the brain wrote.
              if (before.source === "brain") expect(next.source).not.toBe("fallback");
            }
            stored = brief({ text: next.text, basis: next.basis, source: briefSourceOf(next) });
            writes += 1;
          }
          return writes;
        };
        apply(made);
        // The same drafts again, as after a restart that replays the page: nothing is written.
        expect(apply(made)).toBe(0);
      }),
    );
  });
});
