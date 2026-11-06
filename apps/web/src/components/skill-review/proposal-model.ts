import type { SkillProposalView } from "@hobbots/api";
import type { SkillProposal } from "@hobbots/domain";
import { diffLines } from "diff";
import { messages } from "./messages.ts";

const copy = messages;

/** A skill's name in words, for a title: `release-steps` reads "Release steps". */
export const skillTitle = (name: string): string => {
  const words = name.replace(/-/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
};

/** What a proposal asks, as a title, given who asks: "Pip drafted a skill: Launch email". */
export const proposalWhat = (proposal: SkillProposal, who: string): string =>
  proposal.base === null
    ? copy.whatNew({ who, title: skillTitle(proposal.name) })
    : copy.whatChange({ who, title: skillTitle(proposal.name) });

/** The revision a change was read at, or the newest when the skill moved on since: what it is shown against. */
const shownAgainst = (view: SkillProposalView) => view.latest?.number ?? view.proposal.base?.number ?? 0;

/** The number the revision it adds would have, once added. */
const nextNumber = (view: SkillProposalView): number =>
  view.proposal.added?.number ?? (view.proposal.base === null ? 1 : shownAgainst(view) + 1);

/** The revision line of the card: "new · r1", or "r5 → r6". */
export const proposalRevision = (view: SkillProposalView): string =>
  view.proposal.base === null
    ? copy.revisionNew
    : copy.revisionChange({ from: shownAgainst(view), to: nextNumber(view) });

/** One line of the change: added, removed, or the same on both sides. */
export interface ProposalLine {
  readonly op: "add" | "del" | "same";
  readonly text: string;
}

const linesOf = (text: string) => {
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
};

/** How long a diff may take before it shows the whole of each side. */
const DIFF_TIMEOUT_MS = 1_000;

/**
 * The change a proposal makes to `SKILL.md`, line by line: every line added for a new skill, and
 * against the newest revision for a stale change.
 */
export const proposalLines = (view: SkillProposalView): ReadonlyArray<ProposalLine> => {
  const before = view.latest?.instructions ?? view.base ?? "";
  const after = view.proposal.instructions;
  if (before === "") return linesOf(after).map((text) => ({ op: "add", text }));
  const parts = diffLines(before, after, { timeout: DIFF_TIMEOUT_MS }) ?? [
    { value: before, added: false, removed: true, count: 0 },
    { value: after, added: true, removed: false, count: 0 },
  ];
  return parts.flatMap((part) =>
    linesOf(part.value).map((text): ProposalLine => ({ op: part.added ? "add" : part.removed ? "del" : "same", text })),
  );
};

/** Where adding it reaches, in words: the hob's own skills for a new one, else the scopes it rolls out to. */
export const proposalDestination = (view: SkillProposalView, who: string): string => {
  if (view.proposal.base === null || view.rollout === null) return copy.destinationOwn({ who });
  const scopes = view.rollout.scopes;
  if (scopes.some((scope) => scope._tag === "Everyone")) return copy.destinationEveryone;
  const projects = scopes.filter((scope) => scope._tag === "Project").length;
  const hobs = scopes.filter((scope) => scope._tag === "Hob").length;
  const parts = [
    ...(projects > 0 ? [copy.destinationProjects({ count: projects })] : []),
    ...(hobs > 0 ? [copy.destinationHobs({ count: hobs })] : []),
  ];
  return parts.length === 0 ? copy.destinationNone : copy.destination({ parts });
};

/** The Add button's words: for the hob itself, or the rollout, counted in hobs when only hobs are reached. */
export const addLabel = (view: SkillProposalView, who: string): string => {
  if (view.proposal.base === null || view.rollout === null) return copy.addOwn({ who });
  const scopes = view.rollout.scopes;
  return scopes.length > 0 && scopes.every((scope) => scope._tag === "Hob")
    ? copy.addRollOutHobs({ count: scopes.length })
    : copy.addRollOut;
};

/** The line under the card: what adding it does. */
export const proposalFoot = (view: SkillProposalView): string => {
  if (view.proposal.base === null || view.rollout === null) return copy.footNew;
  const next = nextNumber(view);
  return view.rollout.held > 0 ? copy.footHeld({ count: view.rollout.held, next }) : copy.footChange({ next });
};

/** What a decided proposal says happened. */
export const proposalOutcome = (proposal: SkillProposal, who: string): string => {
  const title = skillTitle(proposal.name);
  switch (proposal.state) {
    case "added": {
      const number = proposal.added?.number ?? 1;
      const done =
        proposal.base === null
          ? copy.outcomeAddedOwn({ title, who, number })
          : copy.outcomeAddedChange({ title, number });
      return proposal.edited ? `${done} ${copy.outcomeEdited}` : done;
    }
    case "declined":
      return copy.outcomeDeclined({ who });
    case "adding":
      return copy.outcomeAdding;
    default:
      return "";
  }
};
