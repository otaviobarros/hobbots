import { describe, expect, it } from "vitest";
import {
  addFolder,
  answersWithin,
  enforcement,
  folderName,
  foldersShared,
  PRESETS,
  pickAnswer,
  presetInfo,
  RULES,
  removeFolder,
} from "./safety.ts";

describe("safety presets", () => {
  it("offers Careful, Balanced and Trusting, with Balanced recommended", () => {
    expect(PRESETS.map((p) => p.id)).toEqual(["careful", "balanced", "trusting"]);
    expect(PRESETS.filter((p) => p.recommended).map((p) => p.id)).toEqual(["balanced"]);
    expect(presetInfo("trusting").label).toBe("Trusting");
  });

  // The onboarding wording table of ADR 014, written out here so a change to the policy shows.
  it("shows each preset's answers as ADR 014 words them", () => {
    const rows = [
      "Read your folders",
      "Create and edit files",
      "Delete files",
      "Run commands",
      "Use the web",
      "Push your work",
      "Anything outside your folders",
    ];
    const table = {
      careful: ["Allow", "Ask", "Ask", "Ask", "Ask", "Ask", "Never"],
      balanced: ["Allow", "Allow", "Ask", "Allow", "Allow", "Ask", "Never"],
      trusting: ["Allow", "Allow", "Allow", "Allow", "Allow", "Allow", "Never"],
    } as const;
    for (const preset of PRESETS) {
      expect(preset.rules).toEqual(rows.map((row, i) => [row, table[preset.id][i]]));
    }
  });
});

describe("per-hob rules", () => {
  it("lists every operation the policy decides once", () => {
    expect(RULES.map((r) => r.operation).sort()).toEqual([
      "delete-files",
      "edit-files",
      "local-git",
      "outside-folders",
      "push",
      "read-files",
      "run-commands",
      "use-web",
    ]);
  });

  it("offers only the preset's answer and narrower ones", () => {
    expect(answersWithin("allow")).toEqual(["allow", "ask", "deny"]);
    expect(answersWithin("ask")).toEqual(["ask", "deny"]);
    expect(answersWithin("deny")).toEqual(["deny"]);
  });

  it("drops an override that matches the preset and keeps a narrower one", () => {
    const narrowed = pickAnswer({}, "run-commands", "ask", "balanced");
    expect(narrowed).toEqual({ "run-commands": "ask" });
    expect(pickAnswer({ ...narrowed, push: "deny" }, "run-commands", "allow", "balanced")).toEqual({ push: "deny" });
  });

  it("marks deleting checked, and pushing checked while commands and the web are both allowed", () => {
    const balanced = {
      "read-files": "allow",
      "edit-files": "allow",
      "delete-files": "ask",
      "run-commands": "allow",
      "local-git": "allow",
      push: "ask",
      "use-web": "allow",
      "outside-folders": "deny",
    } as const;
    expect(enforcement("delete-files", balanced)).toBe("checked");
    expect(enforcement("push", balanced)).toBe("checked");
    expect(enforcement("push", { ...balanced, "use-web": "ask" })).toBe("enforced");
    expect(enforcement("read-files", balanced)).toBe("enforced");
    expect(enforcement("read-files", balanced, "off")).toBe("checked");
  });
});

describe("folders", () => {
  it("names a folder by its last part", () => {
    expect(folderName("/Users/me/code")).toBe("code");
    expect(folderName("/Users/me/code/")).toBe("code");
    expect(folderName("/")).toBe("/");
  });

  it("adds a folder once and removes it", () => {
    const once = addFolder(["/a"], "/b");
    expect(addFolder(once, "/a")).toEqual(["/a", "/b"]);
    expect(removeFolder(once, "/a")).toEqual(["/b"]);
  });

  it("counts shared folders", () => {
    expect(foldersShared(0)).toBe("No folders shared");
    expect(foldersShared(1)).toBe("1 folder shared");
  });
});
