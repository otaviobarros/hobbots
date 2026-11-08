import { type Agent, AgentId, SkillId, SkillName, SkillRevisionHash, SkillTrial } from "@hobbots/domain";
import { describe, expect, it } from "vitest";
import { ApiError } from "../../api/client.ts";
import { draftFields, draftSearch, trialErrorText, trialHobs } from "./try-in-chat-model.ts";

const hob = (id: string, status: Agent["status"]) => ({ id: AgentId.make(id), name: id, status }) as Agent;
const trial = (more: Partial<SkillTrial>) =>
  new SkillTrial({
    name: SkillName.make("changelog"),
    description: "Writes the changelog when you cut a release.",
    hash: SkillRevisionHash.make("1".repeat(64)),
    skillId: null,
    base: null,
    proposalId: null,
    ...more,
  });

describe("Try in a chat (ADR 029, Try in a chat)", () => {
  // covers ADR 029 (Try in a chat), #1099
  it("[TC-UI-1099-03] offers the hobs that are awake, the one that proposed it first", () => {
    const hobs = [hob("pip", "active"), hob("quill", "active"), hob("moss", "paused")];
    expect(trialHobs(hobs, AgentId.make("quill")).map((one) => one.id)).toEqual(["quill", "pip"]);
    expect(trialHobs(hobs, AgentId.make("moss")).map((one) => one.id)).toEqual(["pip", "quill"]);
  });

  it("[TC-UI-1099-04] says why a try failed: a check refused it, the draft or the hob is gone", () => {
    expect(trialErrorText(new ApiError("SKILL.md has no front matter.", "SkillImportRefused"))).toContain(
      "SKILL.md has no front matter.",
    );
    expect(trialErrorText(new ApiError("gone", "SkillProposalMissing"))).toBe(
      trialErrorText(new ApiError("gone", "SkillMissing")),
    );
    expect(trialErrorText(new ApiError("gone", "HobUnavailable"))).not.toBe(trialErrorText(new Error("network")));
  });

  it("[TC-UI-1099-05] leads back to the draft you tried in the editor it came from, opened on that text", () => {
    const base = SkillRevisionHash.make("2".repeat(64));
    expect(draftSearch(trial({ proposalId: "p1", skillId: SkillId.make("release") }), "t1")).toEqual({
      view: "review",
      item: "p1",
      trial: "t1",
    });
    expect(draftSearch(trial({ skillId: SkillId.make("release"), base }), "t1")).toEqual({
      skill: "release",
      edit: "skill",
      trial: "t1",
    });
    expect(draftSearch(trial({}), "t1")).toEqual({ edit: "new", trial: "t1" });
    const tried = trial({});
    expect(
      draftFields({
        trial: tried,
        text: "---\nname: changelog\ndescription: Writes the changelog when you cut a release.\n---\n\nNewest first.\n",
      }),
    ).toEqual({
      name: "changelog",
      description: "Writes the changelog when you cut a release.",
      body: "Newest first.\n",
    });
  });
});
