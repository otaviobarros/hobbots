import { PRESET_DECISIONS } from "@hobbots/domain";
import { describe, expect, it } from "vitest";
import { enforcementFixture } from "../test/enforcement.ts";
import { needsSandbox, sandboxState, toolHolding } from "./enforcement.ts";

const permissions = (sandbox: Parameters<typeof enforcementFixture>[0]) => ({
  decisions: PRESET_DECISIONS.balanced,
  enforcement: enforcementFixture(sandbox),
});

describe("unsupported enforcement", () => {
  it("blocks commands, local Git and the web only where the sandbox cannot start", () => {
    const unsupported = enforcementFixture("unsupported");
    expect(sandboxState(unsupported)).toBe("unavailable");
    expect(["run-commands", "local-git", "use-web"].every((op) => needsSandbox(op as never, unsupported))).toBe(true);
    expect(needsSandbox("read-files", unsupported)).toBe(false);
    expect(needsSandbox("edit-files", unsupported)).toBe(false);
    // An unverified sandbox still starts, so nothing is blocked.
    expect(sandboxState(enforcementFixture("unverified"))).toBe("on");
    expect(needsSandbox("run-commands", enforcementFixture("unverified"))).toBe(false);
  });

  it("shows a tool as needing the sandbox rather than held when it cannot start", () => {
    const commands = [["Run", "run-commands"]] as const;
    expect(toolHolding(commands, permissions("unsupported"))).toEqual({ kind: "needs-sandbox" });
    expect(toolHolding(commands, permissions("verified"))).toEqual({ kind: "held", verified: true });
    expect(toolHolding(commands, permissions("unverified"))).toEqual({ kind: "held", verified: false });
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
