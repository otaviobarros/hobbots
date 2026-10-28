import { describe, expect, it } from "vitest";
import { formatWhen, greeting } from "./time.ts";

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
