import { DateTime } from "effect";
import { describe, expect, it } from "vitest";
import { periodStart } from "../src/usage.ts";

const now = DateTime.makeUnsafe("2026-11-02T18:00:00.000Z");
const iso = (time: DateTime.Utc) => DateTime.formatIso(time);

describe("the Usage report's period", () => {
  // covers OP-002
  it("[TC-OP-075] starts at the client's own midnight, else the rolling days before now", () => {
    // A reader at UTC-3 at 15:00 on November 2: its 7 days start at midnight on October 27, local.
    expect(iso(periodStart(now, 7, "2026-10-27T03:00:00.000Z"))).toBe("2026-10-27T03:00:00.000Z");
    // Across a clock change, the reader's 7 days can be an hour longer than 7 times 24 hours.
    expect(iso(periodStart(now, 7, "2026-10-26T17:00:00.000Z"))).toBe("2026-10-26T17:00:00.000Z");
    // Without a start, or with one too early, in the future or unreadable, the rolling 7 days.
    for (const since of [undefined, "2026-10-20T00:00:00.000Z", "2026-11-03T00:00:00.000Z", "yesterday"]) {
      expect(iso(periodStart(now, 7, since))).toBe("2026-10-26T18:00:00.000Z");
    }
  });
});
