import { describe, expect, it } from "vitest";
import { applyHunks } from "../src/store/patch.ts";

// Rebuilding one version of a page from another with ai-memory's line diff (ADR 028), as a
// conditional restore does.

describe("applyHunks", () => {
  // covers ADR 028 (forget, restore), #961
  it("[TC-GEN-350] applies changes, insertions at the start and removals, and refuses a diff that does not fit", () => {
    const text = "# A\n\none\ntwo\nthree";
    expect(
      applyHunks(text, [
        {
          old_start: 3,
          old_len: 2,
          lines: [
            { op: "-", text: "one" },
            { op: "+", text: "uno" },
            { op: " ", text: "two" },
          ],
        },
      ]),
    ).toBe("# A\n\nuno\ntwo\nthree");
    expect(applyHunks("", [{ old_start: 0, old_len: 0, lines: [{ op: "+", text: "# New" }] }])).toBe("# New\n");
    expect(applyHunks(text, [{ old_start: 5, old_len: 1, lines: [{ op: "-", text: "three" }] }])).toBe(
      "# A\n\none\ntwo",
    );
    expect(applyHunks(text, [{ old_start: 3, old_len: 1, lines: [{ op: "-", text: "eins" }] }])).toBeNull();
    expect(applyHunks(text, [{ old_start: 3, old_len: 1, lines: [{ op: "~", text: "one" }] }])).toBeNull();
    expect(applyHunks(text, [])).toBe(text);
  });
});
