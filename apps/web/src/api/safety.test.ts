import type { HobPermissions } from "@hobbots/api";
import { type AgentId, type CharmOverrides, type PolicyOverrides, PRESET_DECISIONS } from "@hobbots/domain";
import { describe, expect, it } from "vitest";
import { enforcementFixture } from "../test/enforcement.ts";
import {
  addFolder,
  answersWithin,
  enforcement,
  folderName,
  foldersShared,
  offeredAnswer,
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
      "github.comment",
      "github.open-pull-request",
      "github.read",
      "local-git",
      "outside-folders",
      "propose-skill",
      "push",
      "read-files",
      "read-hobs",
      "request-skill",
      "run-commands",
      "save-memory",
      "search-memory",
      "search-skills",
      "skill-feedback",
      "use-web",
    ]);
  });

  it("shows an Ask that Read GitHub cannot give as the Never it acts as", () => {
    expect(offeredAnswer("github.read", "ask")).toBe("deny");
    expect(offeredAnswer("github.read", "allow")).toBe("allow");
    expect(offeredAnswer("push", "ask")).toBe("ask");
  });

  it("offers only the preset's answer and narrower ones", () => {
    expect(answersWithin("allow")).toEqual(["allow", "ask", "deny"]);
    expect(answersWithin("ask")).toEqual(["ask", "deny"]);
    expect(answersWithin("deny")).toEqual(["deny"]);
  });

  it("drops an override that matches the preset and keeps a narrower one", () => {
    const permissions = (overrides: PolicyOverrides, charms: CharmOverrides = {}): HobPermissions => ({
      agentId: "pip" as AgentId,
      configVersion: 1,
      preset: "balanced",
      sharedFolders: [],
      policy: { ownFolders: [], hiddenSharedFolders: [], overrides, charms: { overrides: charms } },
      folders: [],
      decisions: PRESET_DECISIONS.balanced,
      presets: { ...PRESET_DECISIONS.balanced, "github.comment": "ask" },
      enforcement: enforcementFixture(),
    });
    const narrowed = pickAnswer(permissions({}), "run-commands", "ask");
    expect(narrowed).toEqual({ overrides: { "run-commands": "ask" } });
    expect(pickAnswer(permissions({ "run-commands": "ask", push: "deny" }), "run-commands", "allow")).toEqual({
      overrides: { push: "deny" },
    });
    // A Charm's operation is saved with the hob's Charm overrides, apart from the built-in ones.
    expect(pickAnswer(permissions({ push: "deny" }), "github.comment", "deny")).toEqual({
      charms: { overrides: { "github.comment": "deny" } },
    });
    expect(pickAnswer(permissions({}, { "github.comment": "deny" }), "github.comment", "ask")).toEqual({
      charms: { overrides: {} },
    });
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
      "github.read": "allow",
      "github.open-pull-request": "ask",
      "github.comment": "ask",
      "outside-folders": "deny",
      "search-memory": "allow",
      "save-memory": "allow",
      "search-skills": "allow",
      "request-skill": "ask",
      "propose-skill": "allow",
      "skill-feedback": "allow",
      "read-hobs": "allow",
    } as const;
    expect(enforcement("delete-files", balanced)).toBe("checked");
    expect(enforcement("push", balanced)).toBe("checked");
    expect(enforcement("push", { ...balanced, "use-web": "ask" })).toBe("enforced");
    expect(enforcement("read-files", balanced)).toBe("enforced");
    expect(enforcement("read-files", balanced, "off")).toBe("checked");
  });

  it("marks Local Git checked when it is narrower than Run commands, since any command can run Git", () => {
    const balanced = {
      "read-files": "allow",
      "edit-files": "allow",
      "delete-files": "ask",
      "run-commands": "allow",
      "local-git": "allow",
      push: "ask",
      "use-web": "allow",
      "github.read": "allow",
      "github.open-pull-request": "ask",
      "github.comment": "ask",
      "outside-folders": "deny",
      "search-memory": "allow",
      "save-memory": "allow",
      "search-skills": "allow",
      "request-skill": "ask",
      "propose-skill": "allow",
      "skill-feedback": "allow",
      "read-hobs": "allow",
    } as const;
    expect(enforcement("local-git", balanced)).toBe("enforced");
    expect(enforcement("local-git", { ...balanced, "local-git": "deny" })).toBe("checked");
    expect(enforcement("local-git", { ...balanced, "local-git": "ask" })).toBe("checked");
    expect(enforcement("local-git", { ...balanced, "run-commands": "ask", "local-git": "ask" })).toBe("enforced");
    expect(enforcement("local-git", { ...balanced, "run-commands": "deny" })).toBe("enforced");
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
