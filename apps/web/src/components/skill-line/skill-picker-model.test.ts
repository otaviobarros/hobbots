import type { HobSkills } from "@hobbots/api";
import {
  AgentId,
  MemoryProjectIdentity,
  SkillId,
  SkillName,
  SkillRevisionHash,
  type SkillScope,
} from "@hobbots/domain";
import { describe, expect, it } from "vitest";
import {
  dismissedDraft,
  matchingSkills,
  pickedDraft,
  pickerSkills,
  skillPicking,
  slashQuery,
  startedDraft,
} from "./skill-picker-model.ts";

const pip = AgentId.make("pip");
const skill = (name: string, scope: SkillScope, onlyWhenAsked = false) => ({
  skillId: SkillId.make(name),
  name: SkillName.make(name),
  pin: SkillRevisionHash.make("a".repeat(64)),
  scope,
  onlyWhenAsked,
  missingCharms: [],
});
const view: HobSkills = {
  agentId: pip,
  skills: [
    skill("release-steps", { _tag: "Project", identity: MemoryProjectIdentity.make("github.com/me/site") }, true),
    skill("commit-style", { _tag: "Everyone" }),
    skill("launch-email", { _tag: "Hob", agentId: pip }),
  ],
  replaced: [],
  clashes: [],
  optedOut: [],
  projects: [],
  lastUsed: [],
};

describe("picking a skill with / (ADR 029, Explicit use)", () => {
  // covers ADR 029 (Explicit use)
  it("[TC-UI-1096-03] opens on / and the start of a name, filters by it, and picks /name", () => {
    const names = ["launch-email", "release-steps"];
    expect(slashQuery("/", names)).toEqual({ query: "", rest: null });
    expect(slashQuery("/re", names)).toEqual({ query: "re", rest: null });
    expect(slashQuery("/release-steps Ship it", names)).toBeNull();
    expect(slashQuery("Use /re", names)).toBeNull();
    expect(slashQuery("/usr/bin is here", names)).toBeNull();
    expect(matchingSkills(pickerSkills(view, "Pip"), "re").map((one) => one.name)).toEqual(["release-steps"]);
    expect(matchingSkills(pickerSkills(view, "Pip"), "x")).toEqual([]);
    expect(pickedDraft("release-steps")).toBe("/release-steps ");
  });

  // covers ADR 029 (Explicit use)
  it("[TC-UI-1096-04] keeps what was written when Use a skill starts a / before it", () => {
    const names = ["release-steps"];
    const started = startedDraft("Ship it\nwith notes");
    expect(started).toBe("/ Ship it\nwith notes");
    expect(startedDraft("")).toBe("/");
    const slash = slashQuery(started, names);
    expect(slash).toEqual({ query: "", rest: "Ship it\nwith notes" });
    expect(slashQuery("/rel Ship it\nwith notes", names)).toEqual({ query: "rel", rest: "Ship it\nwith notes" });
    expect(pickedDraft("release-steps", slash?.rest ?? null)).toBe("/release-steps Ship it\nwith notes");
    if (slash === null) return expect.unreachable();
    expect(dismissedDraft(started, slash)).toBe("Ship it\nwith notes");
    expect(dismissedDraft("/re", { query: "re", rest: null })).toBe("/re");
  });

  it("[TC-UI-1096-05] says whether the hob's skills are loading, failed, or loaded", () => {
    const refetch = () => undefined;
    expect(skillPicking({ data: undefined, isError: false, refetch }, "Pip").status).toBe("loading");
    expect(skillPicking({ data: undefined, isError: true, refetch }, "Pip").status).toBe("failed");
    expect(skillPicking({ data: view, isError: true, refetch }, "Pip").status).toBe("ready");
  });
});
