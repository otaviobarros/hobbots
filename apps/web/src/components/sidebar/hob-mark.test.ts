import { describe, expect, it } from "vitest";
import { sidebarState } from "./hob-mark.ts";

describe("sidebarState", () => {
  it("lights a hob that waits on you", () => {
    expect(sidebarState("needs-you")).toBe("needs-you");
    expect(sidebarState("waiting")).toBe("needs-you");
  });

  it("marks a hob that thinks or works as working", () => {
    expect(sidebarState("working")).toBe("working");
    expect(sidebarState("thinking")).toBe("working");
  });

  it("says paused for a paused or sleeping hob, and resting otherwise", () => {
    expect(sidebarState("paused")).toBe("paused");
    expect(sidebarState("asleep")).toBe("paused");
    expect(sidebarState("idle")).toBe("resting");
    expect(sidebarState("failed")).toBe("resting");
  });
});
