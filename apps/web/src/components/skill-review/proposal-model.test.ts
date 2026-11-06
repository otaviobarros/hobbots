import type { SkillProposalView } from "@hobbots/api";
import { AgentId, SkillId, SkillProposal, SkillProposalId, SkillRevisionHash } from "@hobbots/domain";
import { describe, expect, it } from "vitest";
import {
  addLabel,
  proposalDestination,
  proposalFoot,
  proposalLines,
  proposalOutcome,
  proposalRevision,
  proposalWhat,
  skillTitle,
} from "./proposal-model.ts";

const pip = AgentId.make("0d6e2f0a-0000-4000-8000-0000000000c1");
const quill = AgentId.make("0d6e2f0a-0000-4000-8000-0000000000c2");
const hash = (n: number) => SkillRevisionHash.make(String(n).repeat(64).slice(0, 64));

const proposal = (fields: Partial<SkillProposal> = {}) =>
  new SkillProposal({
    id: SkillProposalId.make("p1"),
    agentId: pip,
    work: "reply:m1",
    key: "k",
    input: "i",
    name: "launch-email" as SkillProposal["name"],
    description: "Write the launch email.",
    skillId: null,
    base: null,
    instructions: "# Launch email\n\nStep one.\n",
    why: "I wrote it three times.",
    state: "waiting",
    edited: false,
    added: null,
    memoryPages: [],
    threadId: null,
    messageId: null,
    attemptId: null,
    createdAt: "2026-11-01T00:00:00.000Z",
    updatedAt: "2026-11-01T00:00:00.000Z",
    decidedAt: null,
    ...fields,
  });

const fresh: SkillProposalView = { proposal: proposal(), base: null, latest: null, rollout: null };
const change = (
  rollout: SkillProposalView["rollout"],
  latest: SkillProposalView["latest"] = null,
): SkillProposalView => ({
  proposal: proposal({
    skillId: SkillId.make("s1"),
    base: { hash: hash(5), number: 5 },
    instructions: "# Launch email\n\nStep one.\nStep two.\n",
  }),
  base: "# Launch email\n\nStep one.\n",
  latest,
  rollout,
});

describe("a skill proposal in words", () => {
  it("names a new skill and a change, and the revision each makes", () => {
    expect(skillTitle("launch-email")).toBe("Launch email");
    expect(proposalWhat(fresh.proposal, "Pip")).toBe("Pip drafted a skill: Launch email");
    expect(proposalRevision(fresh)).toBe("new · r1");
    const changed = change({ scopes: [], held: 0 });
    expect(proposalWhat(changed.proposal, "Pip")).toBe("Pip suggests a change to Launch email");
    expect(proposalRevision(changed)).toBe("r5 → r6");
    // A stale change is shown against the newest revision.
    expect(proposalRevision(change({ scopes: [], held: 0 }, { number: 7, instructions: "# Launch email\n" }))).toBe(
      "r7 → r8",
    );
  });

  it("shows every line of a new skill as added, and only what a change adds", () => {
    expect(proposalLines(fresh).every((line) => line.op === "add")).toBe(true);
    expect(proposalLines(change({ scopes: [], held: 0 })).filter((line) => line.op !== "same")).toEqual([
      { op: "add", text: "Step two." },
    ]);
  });

  it("says where adding reaches and what the button does", () => {
    expect(proposalDestination(fresh, "Pip")).toBe("Pip's own skills");
    expect(addLabel(fresh, "Pip")).toBe("Add it for Pip");
    const hobs = change({
      scopes: [
        { _tag: "Hob", agentId: pip },
        { _tag: "Hob", agentId: quill },
      ],
      held: 1,
    });
    expect(proposalDestination(hobs, "Pip")).toBe("2 hobs");
    expect(addLabel(hobs, "Pip")).toBe("Accept and roll out to 2 hobs");
    expect(proposalFoot(hobs)).toBe(
      "1 assignment is held and stays where it is. The others move to r6 from their next chat.",
    );
    expect(proposalDestination(change({ scopes: [{ _tag: "Everyone" }], held: 0 }), "Pip")).toBe("every hob");
    expect(addLabel(change({ scopes: [{ _tag: "Everyone" }], held: 0 }), "Pip")).toBe("Accept and roll out");
  });

  it("says what happened once you decided", () => {
    expect(proposalOutcome(proposal({ state: "added", added: { hash: hash(1), number: 1 } }), "Pip")).toBe(
      "Added Launch email r1 for Pip. Pip uses it from its next chat.",
    );
    expect(proposalOutcome(proposal({ state: "declined" }), "Pip")).toBe(
      "Not now. Pip is told, and the library is unchanged.",
    );
  });
});
