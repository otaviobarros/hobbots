import { describe, expect, it } from "vitest";
import { formatCount, formatIn, plural } from "./format.ts";

describe("format", () => {
  it("formats counts and times ahead in the locale", () => {
    expect(formatCount(1240, "en-US")).toBe("1,240");
    expect(formatIn(23, "hour", "en-US")).toBe("in 23 hours");
    expect(formatIn(1, "minute", "en-US")).toBe("in 1 minute");
  });

  it("picks the plural form by the locale's rules", () => {
    const forms = { one: "one", other: "other" };
    expect([0, 1, 2].map((n) => plural(n, forms, "en-US"))).toEqual(["other", "one", "other"]);
  });
});
