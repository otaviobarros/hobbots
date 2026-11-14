import { describe, expect, it } from "vitest";
import { pageHeading, withoutTitle } from "./read.ts";

describe("Markdown the app reads", () => {
  it("finds a page's own first # heading, not one in code, a quote or a list, nor a #word", () => {
    expect(pageHeading("Intro\n\n# **Launch** [plan](https://example.com) ##\n\n# Later")).toBe(
      "**Launch** [plan](https://example.com)",
    );
    expect(pageHeading("```\n# code\n```\n> # quoted\n- # listed\n#word")).toBeUndefined();
    expect(pageHeading("## Only a second level")).toBeUndefined();
  });

  it("drops only the # heading a page opens with", () => {
    expect(withoutTitle("  # Title\n\nBody\n")).toBe("Body");
    expect(withoutTitle("Body\n\n# Later")).toBe("Body\n\n# Later");
  });
});
