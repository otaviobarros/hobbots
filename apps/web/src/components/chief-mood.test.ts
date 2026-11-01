import { describe, expect, it } from "vitest";
import { chiefLabel, chiefMood } from "./chief-mood.ts";

describe("the chief's mood", () => {
  it("raises the needs-you lantern as soon as a request waits, over working hobs", () => {
    expect(chiefMood({ waiting: 1, working: false })).toBe("needs-you");
    expect(chiefMood({ waiting: 3, working: true })).toBe("needs-you");
  });

  it("goes back to working or idle once every request is answered", () => {
    expect(chiefMood({ waiting: 0, working: true })).toBe("working");
    expect(chiefMood({ waiting: 0, working: false })).toBe("idle");
  });

  it("shows the mood a development preview asks for", () => {
    expect(chiefMood({ waiting: 0, working: false, preview: "needs-you" })).toBe("needs-you");
    expect(chiefMood({ waiting: 2, working: false, preview: "idle" })).toBe("idle");
  });
});

describe("the chief's label", () => {
  it("says how many requests wait while it needs you", () => {
    expect(chiefLabel("needs-you", 1)).toBe("Hobbots inbox, a request needs you");
    expect(chiefLabel("needs-you", 3)).toBe("Hobbots inbox, 3 requests need you");
  });

  it("names Home otherwise", () => {
    expect(chiefLabel("working", 0)).toBe("Hobbots home, hobs are working");
    expect(chiefLabel("idle", 0)).toBe("Hobbots home");
  });
});
