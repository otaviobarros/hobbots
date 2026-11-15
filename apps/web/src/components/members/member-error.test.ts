import { describe, expect, it } from "vitest";
import { ApiError } from "../../api/client.ts";
import { memberError } from "./member-error.ts";

describe("memberError", () => {
  // covers ADR 039 (Members), #1467
  it("tells a hob that leads an open quest and an archived camp from other refusals and from no answer (#1467)", () => {
    expect(memberError(new ApiError("", "MembershipRefused", { reason: "leads-quest" }))).toBe("leads-quest");
    expect(memberError(new ApiError("", "MembershipRefused", { reason: "lead" }))).toBe("refused");
    expect(memberError(new ApiError("", "HobUnavailable"))).toBe("hob-unavailable");
    expect(memberError(new ApiError("", "ThreadArchived"))).toBe("archived");
    expect(memberError(new TypeError("Failed to fetch"))).toBe("unreachable");
  });
});
