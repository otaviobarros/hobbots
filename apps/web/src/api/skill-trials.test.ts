import { describe, expect, it } from "vitest";
import { ApiError } from "./client.ts";
import { draftGone } from "./skill-trials.ts";

describe("reading back a tried draft (ADR 029, Try in a chat)", () => {
  // covers ADR 029 (Try in a chat), STD-UI-009, #1099
  it("[TC-UI-1099-07] takes a draft as gone only when the hub says so, and any other failure as one to try again", () => {
    expect(draftGone(new ApiError("gone", "SkillDraftGone"))).toBe(true);
    expect(draftGone(new ApiError("Internal error", "InternalServerError"))).toBe(false);
    expect(draftGone(new ApiError("Failed to fetch", undefined))).toBe(false);
    expect(draftGone(new TypeError("Failed to fetch"))).toBe(false);
  });
});
