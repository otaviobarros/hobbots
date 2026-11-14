import { describe, expect, it } from "vitest";
import { pageHeading } from "../src/store/heading.ts";

describe("a memory page's heading", () => {
  it("is the page's own first # heading, read as CommonMark", () => {
    expect(pageHeading("# Deploy `steps`\n\nRun it.")).toBe("Deploy steps");
    expect(pageHeading("```\n# not one\n```\n#tag")).toBeUndefined();
    expect(pageHeading("# \n")).toBeUndefined();
  });
});
