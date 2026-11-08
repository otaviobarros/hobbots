import { describe, expect, it } from "vitest";
import { enforcementFixture } from "../test/enforcement.ts";
import { needsSandbox, notOffered, sandboxGap } from "./enforcement.ts";

describe("unsupported enforcement", () => {
  it("blocks commands, local Git and the web unless the sandbox is verified", () => {
    // An unverified capability counts as missing (ADR 014), like one that is unsupported.
    for (const gap of ["unsupported", "unverified"] as const) {
      const declaration = enforcementFixture(gap);
      expect(sandboxGap(declaration)).toBe(gap);
      expect(["run-commands", "local-git", "use-web"].every((op) => needsSandbox(op as never, declaration))).toBe(true);
      expect(needsSandbox("read-files", declaration)).toBe(false);
      expect(needsSandbox("edit-files", declaration)).toBe(false);
    }
    expect(sandboxGap(enforcementFixture("verified"))).toBeNull();
    expect(needsSandbox("run-commands", enforcementFixture("verified"))).toBe(false);
  });
});

describe("a runtime without its own web search", () => {
  // covers ADR 036
  it("[TC-PE-1266-03] shows Search the web as not offered unless the runtime's search is verified", () => {
    const verified = enforcementFixture("verified");
    expect(notOffered("search-web", verified)).toBe(false);
    for (const status of ["unsupported", "unverified"] as const) {
      const declaration = { ...verified, webSearch: { status, evidence: "not checked" } };
      expect(notOffered("search-web", declaration)).toBe(true);
      // Every other rule is shown as it always was.
      expect(notOffered("use-web", declaration)).toBe(false);
    }
  });
});
