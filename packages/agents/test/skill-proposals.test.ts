import { AgentId, SkillProposal, SkillProposalId, type SkillProposalState } from "@hobbots/domain";
import { describe, expect, it } from "vitest";
import { proposalLimit } from "../src/skill-proposals.ts";

const pip = AgentId.make("0d6e2f0a-0000-4000-8000-0000000000d1");
const quill = AgentId.make("0d6e2f0a-0000-4000-8000-0000000000d2");

const proposal = (name: string, state: SkillProposalState = "waiting", agentId = pip) =>
  new SkillProposal({
    id: SkillProposalId.make(`${agentId}-${name}`),
    agentId,
    work: "reply:m1",
    key: name,
    input: name,
    name: name as SkillProposal["name"],
    description: "",
    skillId: null,
    base: null,
    instructions: "",
    why: "",
    state,
    edited: false,
    added: null,
    planned: null,
    memoryPages: [],
    threadId: null,
    messageId: null,
    attemptId: null,
    createdAt: "2026-11-01T00:00:00.000Z",
    updatedAt: "2026-11-01T00:00:00.000Z",
    decidedAt: null,
  });

describe("how many proposals a hob may have waiting", () => {
  it("takes one open proposal per name, and three at most", () => {
    expect(proposalLimit([], { agentId: pip, name: proposal("a").name })).toBeNull();
    const same = proposal("a", "adding");
    expect(proposalLimit([same], { agentId: pip, name: same.name })).toEqual({ _tag: "Duplicate", proposal: same });
    const three = [proposal("a"), proposal("b"), proposal("c", "adding")];
    expect(proposalLimit(three, { agentId: pip, name: proposal("d").name })).toEqual({ _tag: "Full", waiting: three });
  });

  it("counts neither decided proposals nor another hob's", () => {
    const others = [proposal("a", "added"), proposal("b", "declined"), proposal("c", "waiting", quill)];
    expect(proposalLimit([...others, proposal("d")], { agentId: pip, name: proposal("a").name })).toBeNull();
    expect(proposalLimit(others, { agentId: pip, name: proposal("c").name })).toBeNull();
  });
});
