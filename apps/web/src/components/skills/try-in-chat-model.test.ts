import { type Agent, AgentId, SkillId, SkillName, SkillRevisionHash, SkillTrial } from "@hobbots/domain";
import { describe, expect, it } from "vitest";
import { ApiError } from "../../api/client.ts";
import { trialErrorText, trialHobs, trialOrigin } from "./try-in-chat-model.ts";

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

  it("[TC-UI-1099-05] leads back to the proposal in To review, or to the skill an edit changes", () => {
    expect(trialOrigin(trial({ proposalId: "p1", skillId: SkillId.make("release") }))).toEqual({
      _tag: "Review",
      item: "p1",
    });
    expect(trialOrigin(trial({ skillId: SkillId.make("release") }))).toMatchObject({
      _tag: "Skill",
      skillId: "release",
    });
    expect(trialOrigin(trial({}))).toBeNull();
  });
});
