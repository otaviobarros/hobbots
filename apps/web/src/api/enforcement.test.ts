import { PRESET_DECISIONS } from "@hobbots/domain";
import { describe, expect, it } from "vitest";
import { enforcementFixture } from "../test/enforcement.ts";
import { needsSandbox, sandboxGap, toolHolding } from "./enforcement.ts";

const permissions = (sandbox: Parameters<typeof enforcementFixture>[0]) => ({
  decisions: PRESET_DECISIONS.balanced,
  enforcement: enforcementFixture(sandbox),
});

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

  it("shows a tool as needing the sandbox, and why, rather than held", () => {
    const commands = [["Run", "run-commands"]] as const;
    expect(toolHolding(commands, permissions("unsupported"))).toEqual({ kind: "needs-sandbox", gap: "unsupported" });
    expect(toolHolding(commands, permissions("unverified"))).toEqual({ kind: "needs-sandbox", gap: "unverified" });
    expect(toolHolding(commands, permissions("verified"))).toEqual({ kind: "held" });
  });

  it("still names the checked rules of a tool the sandbox does not block", () => {
    const files = [
      ["Read", "read-files"],
      ["Edit", "edit-files"],
      ["Delete", "delete-files"],
    ] as const;
    expect(toolHolding(files, permissions("unsupported"))).toEqual({ kind: "checked", labels: ["Delete"] });
  });
});
