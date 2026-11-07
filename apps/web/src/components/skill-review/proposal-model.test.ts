import type { SkillProposalView } from "@hobbots/api";
import { AgentId, SkillId, SkillProposal, SkillProposalId, SkillRevisionHash } from "@hobbots/domain";
import { describe, expect, it } from "vitest";
import {
  addLabel,
  flagLines,
  lineParts,
  proposalDestination,
  proposalFoot,
  proposalLines,
  proposalOutcome,
  proposalReuse,
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

const fresh: SkillProposalView = { proposal: proposal(), base: null, latest: null, rollout: null, check: null };
const change = (
  rollout: SkillProposalView["rollout"],
  latest: SkillProposalView["latest"] = null,
  check: SkillProposalView["check"] = null,
): SkillProposalView => ({
  proposal: proposal({
    skillId: SkillId.make("s1"),
    base: { hash: hash(5), number: 5 },
    instructions: "# Launch email\n\nStep one.\nStep two.\n",
  }),
  base: "# Launch email\n\nStep one.\n",
  latest,
  rollout,
  check,
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

  it("says when a change is a revision the skill already has, before and after you add it", () => {
    const same = change({ scopes: [], held: 0 }, null, { flags: [], existing: 5 });
    expect(proposalReuse(same)).toEqual({ as: "same", number: 5 });
    expect(proposalFoot(same)).toBe("It is what r5 already says, so adding it changes nothing.");
    const earlier = change({ scopes: [], held: 0 }, null, { flags: [], existing: 2 });
    expect(proposalRevision(earlier)).toBe("r5 → r2");
    expect(proposalFoot(earlier)).toBe(
      "It is what r2 said, so adding it brings every hob that uses it back to r2, unless you hold it.",
    );
    const back = proposal({
      state: "added",
      skillId: SkillId.make("s1"),
      base: { hash: hash(5), number: 5 },
      added: { hash: hash(2), number: 2, as: "earlier" },
    });
    expect(proposalOutcome(back, "Pip")).toBe(
      "Accepted. It is what Launch email r2 said, so every hob that uses it goes back to r2 from its next chat.",
    );
    expect(proposalOutcome(proposal({ ...back, added: { hash: hash(5), number: 5, as: "same" } }), "Pip")).toBe(
      "Accepted. It is what Launch email r5 already says, so the library is unchanged.",
    );
  });

  it("names each flag, and marks each character you cannot see where it is", () => {
    expect(
      flagLines([
        { _tag: "Script", path: "run.sh" },
        { _tag: "Url", path: "SKILL.md", url: "https://example.com" },
        { _tag: "HiddenText", path: "SKILL.md", codePoint: "U+200B" },
      ]),
    ).toEqual([
      "run.sh is a script a hob can run.",
      "SKILL.md links to https://example.com.",
      "SKILL.md has characters you cannot see, such as U+200B. Each is marked where it is.",
    ]);
    expect(lineParts("Tag\u200Bit\u202E")).toEqual([
      { _tag: "text", text: "Tag" },
      { _tag: "hidden", codePoint: "U+200B" },
      { _tag: "text", text: "it" },
      { _tag: "hidden", codePoint: "U+202E" },
    ]);
    expect(lineParts("")).toEqual([{ _tag: "text", text: "" }]);
  });

  it("says what happened once you decided", () => {
    expect(proposalOutcome(proposal({ state: "added", added: { hash: hash(1), number: 1, as: "new" } }), "Pip")).toBe(
      "Added Launch email r1 for Pip. Pip uses it from its next chat.",
    );
    expect(proposalOutcome(proposal({ state: "declined" }), "Pip")).toBe(
      "Not now. Pip is told, and the library is unchanged.",
    );
  });
});
