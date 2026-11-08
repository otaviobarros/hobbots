import { EMPTY_HOB_POLICY, type HobPolicy } from "@hobbots/domain";
import { describe, expect, it } from "vitest";
import { narrows, type ToolAccess, turnWebSearch } from "../src/index.ts";

// Search the web (ADR 036): the hub settles whether a turn may search, and narrowing it stops a running turn.

const access = (overrides: HobPolicy["overrides"] = {}): ToolAccess => ({
  policy: {
    preset: "balanced",
    sharedFolders: ["/work"],
    hob: { ...EMPTY_HOB_POLICY, overrides },
    dataFolder: "/data",
    restrictions: [],
  },
  folders: ["/work"],
  runtimeFolder: "/runtimes/hob",
  commitsAs: { _tag: "UserConfig", config: { name: "Ada", email: "ada@example.com" } },
});

describe("Search the web", () => {
  // covers PE-008, ADR 036
  it("[TC-PE-1266-02] stops a running turn when Search the web is set to Never, not when it is allowed again", () => {
    expect(narrows(access(), access({ "search-web": "deny" }))).toBe(true);
    expect(narrows(access({ "search-web": "deny" }), access())).toBe(false);
  });

  it("lets a turn search only with tools and an Allow answer", () => {
    expect(turnWebSearch(access())).toBe(true);
    expect(turnWebSearch(access({ "search-web": "deny" }))).toBe(false);
    expect(turnWebSearch(null)).toBe(false);
  });
});
