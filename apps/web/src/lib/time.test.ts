import { describe, expect, it } from "vitest";
import { formatDay, formatWhen, greeting, refillText } from "./time.ts";

describe("formatWhen", () => {
  const now = new Date(2026, 9, 28, 15, 0);
  it("says Now within a minute", () =>
    expect(formatWhen(new Date(2026, 9, 28, 14, 59, 30).toISOString(), now)).toBe("Now"));
  it("counts minutes within the hour", () =>
    expect(formatWhen(new Date(2026, 9, 28, 14, 48).toISOString(), now)).toBe("12 min"));
  it("says Yesterday for the previous day", () =>
    expect(formatWhen(new Date(2026, 9, 27, 9, 0).toISOString(), now)).toBe("Yesterday"));
});

describe("greeting", () => {
  it("follows the local hour", () => {
    expect(greeting(new Date(2026, 9, 28, 8))).toBe("Good morning");
    expect(greeting(new Date(2026, 9, 28, 21))).toBe("Good evening");
  });
});

describe("formatDay", () => {
  const now = new Date(2026, 9, 28, 15, 0);
  it("leaves out this year and names another", () => {
    expect(formatDay(new Date(2026, 9, 12, 9).toISOString(), now)).not.toMatch(/2026/);
    expect(formatDay(new Date(2025, 8, 30, 9).toISOString(), now)).toMatch(/2025/);
  });
});

describe("refillText", () => {
  const now = new Date(2026, 9, 28, 15, 8);
  it("says when the allowance refills and how long that is", () => {
    const at = new Date(2026, 9, 28, 16, 0).toISOString();
    expect(refillText(at, now)).toMatch(/^It refills at .+, in 52 minutes\.$/);
    expect(refillText(new Date(2026, 9, 28, 15, 9).toISOString(), now)).toMatch(/in 1 minute\.$/);
    expect(refillText(new Date(2026, 9, 28, 18, 8).toISOString(), now)).toMatch(/in 3 hours\.$/);
  });

  it("is honest when the time is unknown or already past", () => {
    expect(refillText(null, now)).toBe("It refills later; the provider did not say when.");
    expect(refillText(new Date(2026, 9, 28, 15, 0).toISOString(), now)).toBe("It should have refilled by now.");
  });
});
