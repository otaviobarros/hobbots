import type { MemoryCheck } from "@hobbots/api";
import {
  type MemoryFinding,
  type MemoryKind,
  type MemoryShare,
  memoryKindOf,
  memoryShareWaits,
} from "@hobbots/domain";
import { type HobDirectory, pageBody, pageTitle, scopeName } from "./memory-model.ts";
import { messages } from "./messages.ts";

const copy = messages.review;

/**
 * What Memory › To review lists (ADR 028, Sharing): the shares that wait for you, oldest first, then
 * what the last Check now found. A share also waits in the Inbox; a finding waits only here.
 */
export type ReviewItem =
  | { readonly _tag: "Share"; readonly key: string; readonly share: MemoryShare }
  | { readonly _tag: "Finding"; readonly key: string; readonly finding: MemoryFinding };

/** The key a finding has in the address: its place in the last check. */
export const findingKey = (index: number) => `check:${index}`;

export const reviewItems = (
  shares: ReadonlyArray<MemoryShare>,
  check: MemoryCheck | undefined,
): ReadonlyArray<ReviewItem> => [
  ...shares.filter(memoryShareWaits).map((share) => ({ _tag: "Share" as const, key: share.id, share })),
  ...(check?.findings ?? []).map((finding, index) => ({
    _tag: "Finding" as const,
    key: findingKey(index),
    finding,
  })),
];

/**
 * The item open in To review: the one the address names. A share decided while it was open stays
 * open, so its outcome and Undo show; otherwise the first item.
 */
export const openItem = (
  items: ReadonlyArray<ReviewItem>,
  shares: ReadonlyArray<MemoryShare>,
  key: string | null,
): ReviewItem | undefined => {
  const named = key === null ? undefined : items.find((item) => item.key === key);
  if (named !== undefined) return named;
  const decided = key === null ? undefined : shares.find((share) => share.id === key);
  if (decided !== undefined) return { _tag: "Share", key: decided.id, share: decided };
  return items[0];
};

/** Where a share goes, in words: "the site project" or "About you". */
export const shareDestination = (share: MemoryShare, hobs: HobDirectory): string =>
  share.scope._tag === "Project" ? copy.toProject({ name: scopeName(share.scope, hobs) }) : copy.toEveryone;

/** The hob a share comes from, by name. */
export const shareFrom = (share: MemoryShare, hobs: HobDirectory): string =>
  hobs.get(share.agentId)?.name ?? messages.nav.formerHob;

/** A share goes to a project or to About you, which name no hob. */
const NO_HOBS: HobDirectory = new Map();

/** What a share asks, as a title, given who asks: "Ada wants to add a how-to to the site project". */
export const shareWhat = (share: MemoryShare, who: string): string => {
  const hobs = NO_HOBS;
  const kind = memoryKindOf(share.path);
  return share.scope._tag === "Project"
    ? copy.whatProject({ who, kind: kindArticle(kind), name: scopeName(share.scope, hobs) })
    : copy.whatEveryone({ who });
};

/** A kind with its article, for a sentence: "a how-to", "an other page". */
const kindArticle = (kind: MemoryKind) => {
  const word = messages.kinds[kind].one.toLowerCase();
  return /^[aeiou]/.test(word) ? `an ${word}` : `a ${word}`;
};

/** The page a share would add, as the lines it adds: its title as a heading, then each line of its body. */
export const shareLines = (share: MemoryShare): ReadonlyArray<string> =>
  pageBody(share.markdown)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");

export const shareTitle = (share: MemoryShare): string => pageTitle(share.markdown, share.path);

/** What a decided share says happened. */
export const shareOutcome = (share: MemoryShare, hobs: HobDirectory): string => {
  const who = shareFrom(share, hobs);
  switch (share.state) {
    case "shared":
      return share.scope._tag === "Project"
        ? copy.sharedProject({ name: scopeName(share.scope, hobs) })
        : copy.sharedEveryone;
    case "kept":
      return copy.kept({ who });
    case "undone":
      return copy.undone({ who });
    default:
      return "";
  }
};

/** What a finding is, as a title. */
export const findingWhat = (finding: MemoryFinding): string =>
  finding.kind === "disagree" ? copy.disagree({ count: finding.paths.length }) : copy.stale;
