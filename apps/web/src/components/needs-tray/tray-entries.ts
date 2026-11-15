import type { HobProposalView, WaitingQuestion } from "@hobbots/api";
import {
  type ApprovalRequest,
  type BackpackItem,
  type HubQuestion,
  hobProposalOpen,
  openBlocker,
  type ChannelId,
} from "@hobbots/domain";
import {
  approvalEntry,
  entryChannel,
  hobProposalEntry,
  hubQuestionEntry,
  type InboxEntry,
  questionEntry,
  stuckEntry,
} from "../inbox/inbox-entries.ts";

/**
 * One thing the tray asks about: a request to approve, a hob proposal (ADR 034), work that is stuck,
 * or a question for you, a hob's or the hub's. A hob asking to share what it learned, or proposing a
 * skill, waits in the Inbox, never in the way of a chat, and so does a write a Task made whose answer
 * was lost, which also waits in its quest, under its hob (ADR 038).
 */
export type TrayEntry = Exclude<
  InboxEntry,
  { kind: "device" } | { kind: "failed" } | { kind: "memory" } | { kind: "skill" } | { kind: "charm-call" }
>;

/**
 * What the tray holds, in the order it asks: pending approvals and hob proposals, then stuck work, then questions,
 * hobs' then the hub's own (#976), each oldest first. With `channelId`, only what is about that
 * channel: a hub question shows in the tray of the chat it concerns, and on Home.
 */
export const trayEntries = ({
  requests,
  blockers,
  questions,
  hubQuestions = [],
  hobProposals = [],
  channelId,
}: {
  readonly requests: ReadonlyArray<ApprovalRequest>;
  readonly blockers: ReadonlyArray<BackpackItem>;
  readonly questions: ReadonlyArray<WaitingQuestion>;
  readonly hubQuestions?: ReadonlyArray<HubQuestion>;
  readonly hobProposals?: ReadonlyArray<HobProposalView>;
  readonly channelId?: ChannelId | undefined;
}): ReadonlyArray<TrayEntry> => {
  const entries = [
    ...requests.filter((request) => request.state === "pending").map(approvalEntry),
    ...hobProposals.filter((view) => hobProposalOpen(view.proposal)).map(hobProposalEntry),
    ...blockers.filter((item) => openBlocker(item) !== undefined).map(stuckEntry),
    ...questions.filter(({ question }) => question.state === "open").map(questionEntry),
    ...hubQuestions.filter((question) => question.state === "open").map(hubQuestionEntry),
  ].filter((entry): entry is TrayEntry => entry.kind !== "device" && entry.kind !== "memory");
  return channelId === undefined ? entries : entries.filter((entry) => entryChannel(entry) === channelId);
};

/**
 * Where a chat's or camp's tray looks: only at what is about that chat or camp, or at what waits
 * everywhere, as on Home (#1423).
 */
export type TrayScope = "here" | "everywhere";

/** What a chat's or camp's tray holds in each scope, from everything that waits on you. */
export const scopedTray = (
  everywhere: ReadonlyArray<TrayEntry>,
  channelId: ChannelId,
): { readonly here: ReadonlyArray<TrayEntry>; readonly everywhere: ReadonlyArray<TrayEntry> } => ({
  here: everywhere.filter((entry) => entryChannel(entry) === channelId),
  everywhere,
});

/**
 * The entry the tray shows: the one it showed before while that one still waits, else the one now
 * at the same place, else the last. Undefined when nothing waits.
 */
export const shownEntry = (
  entries: ReadonlyArray<TrayEntry>,
  key: string | undefined,
  index: number,
): { readonly entry: TrayEntry; readonly index: number } | undefined => {
  if (entries.length === 0) return undefined;
  const kept = entries.findIndex((entry) => entry.key === key);
  const at = kept >= 0 ? kept : Math.min(index, entries.length - 1);
  return { entry: entries[at] as TrayEntry, index: at };
};
