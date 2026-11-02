import { describe, expect, it } from "vitest";
import { formatAgo, formatCount, formatIn, plural } from "./format.ts";

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

  it("formats times past in the locale, in the largest whole unit", () => {
    const now = new Date("2026-11-02T15:00:00Z");
    expect(formatAgo("2026-11-02T14:59:30Z", now, "en-US")).toBe("now");
    expect(formatAgo("2026-11-02T14:55:00Z", now, "en-US")).toBe("5 minutes ago");
    expect(formatAgo("2026-11-02T12:30:00Z", now, "en-US")).toBe("2 hours ago");
    expect(formatAgo("2026-11-01T12:00:00Z", now, "en-US")).toBe("yesterday");
    expect(formatAgo("2026-11-02T15:00:05Z", now, "en-US")).toBe("now");
  });
});
