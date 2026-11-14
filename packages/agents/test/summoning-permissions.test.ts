import { AgentId, type HobPolicy } from "@hobbots/domain";
import { describe, expect, it } from "vitest";
import { changedFieldWords, changedPolicy, summoningPermissions } from "../src/index.ts";

// A Summoning change sets only the answers it names (#1352, ADR 034: "only the fields that change").

const thorn: HobPolicy = {
  ownFolders: [],
  hiddenSharedFolders: [],
  overrides: { "edit-files": "deny", "delete-files": "deny", push: "deny", "use-web": "ask" },
  charms: {
    granted: ["github", "summoning"],
    overrides: { "github.open-pull-request": "deny", "summoning.summon": "ask" },
  },
};

const change = (fields: Omit<Parameters<typeof summoningPermissions>[0], "hob">) => ({
  hob: AgentId.make("thorn"),
  ...fields,
});

describe("summoningPermissions", () => {
  it("[TC-AG-1352-01] a change that sets one Charm answer keeps every other built-in and Charm answer", () => {
    const payload = summoningPermissions(change({ answers: { "github.comment": "ask" } }), thorn);
    expect(payload).not.toBeNull();
    const after = changedPolicy(thorn, payload ?? {});
    expect(after.overrides).toEqual(thorn.overrides);
    expect(after.charms?.overrides).toEqual({
      "github.open-pull-request": "deny",
      "github.comment": "ask",
      "summoning.summon": "ask",
    });
    expect(after.charms?.granted).toEqual(["github", "summoning"]);
  });

  it("[TC-AG-1352-02] a change that sets one built-in answer keeps the others and every Charm answer", () => {
    const payload = summoningPermissions(change({ answers: { "run-commands": "deny" } }), thorn);
    const after = changedPolicy(thorn, payload ?? {});
    expect(after.overrides).toEqual({ ...thorn.overrides, "run-commands": "deny" });
    expect(after.charms?.overrides).toEqual(thorn.charms?.overrides);
  });

  it("[TC-AG-1352-03] Charms alone, or an empty answer map, leave every answer as it was", () => {
    for (const fields of [{ charms: ["github"] }, { answers: {} }]) {
      const after = changedPolicy(thorn, summoningPermissions(change(fields), thorn) ?? {});
      expect(after.overrides).toEqual(thorn.overrides);
      expect(after.charms?.overrides).toEqual(thorn.charms?.overrides);
    }
    expect(summoningPermissions(change({ name: "Thorn" }), thorn)).toBeNull();
  });
});

describe("changedFieldWords", () => {
  it("[TC-AG-1352-04] names each answer a change sets, and says Charms only when it gives Charms", () => {
    expect(changedFieldWords(change({ answers: { "github.comment": "ask", push: "deny" } }))).toBe(
      "answers (github.comment Ask, push Never)",
    );
    expect(changedFieldWords(change({ name: "Thorn", charms: ["github"], answers: { "use-web": "allow" } }))).toBe(
      "name, Charms, answers (use-web Allow)",
    );
  });
});
