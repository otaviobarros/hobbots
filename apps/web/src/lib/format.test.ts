import { describe, expect, it } from "vitest";
import {
  formatAgo,
  formatBytes,
  formatCompact,
  formatCount,
  formatDuration,
  formatIn,
  formatMoment,
  formatMoney,
  formatMonthDay,
  formatPercent,
  formatWeekdayDate,
  plural,
} from "./format.ts";

describe("format", () => {
  it("formats counts and times ahead in the locale", () => {
    expect(formatCount(1240, "en-US")).toBe("1,240");
    expect(formatIn(23, "hour", "en-US")).toBe("in 23 hours");
    expect(formatIn(1, "minute", "en-US")).toBe("in 1 minute");
  });

  it("shortens large counts and formats shares and money in the locale", () => {
    expect([formatCompact(950, "en-US"), formatCompact(12_340, "en-US"), formatCompact(1_420_000, "en-US")]).toEqual([
      "950",
      "12.3K",
      "1.4M",
    ]);
    expect(formatPercent(38, "en-US")).toBe("38%");
    expect([formatMoney(1250, "USD", "en-US"), formatMoney(500, "JPY", "en-US")]).toEqual(["$12.50", "¥500"]);
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

  it("names a size in the largest unit that keeps it at 1 or more", () => {
    expect(formatBytes(512, "en-US")).toBe("512 byte");
    expect(formatBytes(16 * 1024, "en-US")).toBe("16 kB");
    expect(formatBytes(3.45 * 1024 * 1024, "en-US")).toBe("3.5 MB");
    expect(formatBytes(2.5 * 1024 * 1024 * 1024, "en-US")).toBe("2.5 GB");
  });

  it("names a day of the month, and a weekday with or without the year", () => {
    expect(formatMonthDay(new Date(2026, 9, 2), "en-US")).toBe("Oct 2");
    expect(formatWeekdayDate(new Date(2026, 10, 1), false, "en-US")).toBe("Sun, Nov 1");
    expect(formatWeekdayDate(new Date(2025, 11, 30), true, "en-US")).toBe("Tue, Dec 30, 2025");
  });
});
