import { describe, expect, it } from "vitest";
import { formatAgo, formatCount, formatDuration, formatIn, formatMoment, plural } from "./format.ts";

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

  it("formats how long something took, to the second", () => {
    expect(formatDuration(420, "en-US")).toBe("0.4 sec");
    expect(formatDuration(12_900, "en-US")).toBe("12 sec");
    expect(formatDuration(184_000, "en-US")).toBe("3 min 4 sec");
    expect(formatDuration(120_000, "en-US")).toBe("2 min");
    expect(formatDuration(3_900_000, "en-US")).toBe("1 hr 5 min");
    expect(formatDuration(30, "en-US")).toBe("0.1 sec");
    expect(formatDuration(-5, "en-US")).toBe("0 sec");
  });

  it("names a moment by its day and time", () => {
    expect(formatMoment("2026-11-03T12:00:00.000Z", "en-US")).toMatch(/^Nov [34], 2026, \d{1,2}:\d{2}\s?[AP]M$/);
  });
});
