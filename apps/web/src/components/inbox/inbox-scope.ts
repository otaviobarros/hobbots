import { hobProposalOpen, memoryShareWaits, skillProposalOpen, type ThreadId } from "@hobbots/domain";
import { Schema } from "effect";
import { entryThread, type InboxEntry } from "./inbox-entries.ts";
import type { InboxTab } from "./inbox-items.ts";

/**
 * Whether the Inbox, opened on a chat or camp from its tray's See all (#1423), lists only what is
 * about that chat or camp, or what waits everywhere.
 */
export const InboxScope = Schema.Literals(["here", "everywhere"]);
export type InboxScope = typeof InboxScope.Type;

/** The chat or camp the Inbox opened on, and its scope; undefined when it opened on everything. */
export interface InboxIn {
  readonly threadId: ThreadId;
  readonly scope: InboxScope;
}

/** The search params that keep the Inbox on its chat or camp, for every link that stays in it. */
type InSearch = { readonly in?: ThreadId; readonly scope?: "everywhere" };

/** A link inside the Inbox: its tab, and the chat or camp it stays on. */
export type InboxSearch = InSearch & { readonly tab: InboxTab };

export const inSearch = (scope: InboxIn | undefined): InSearch =>
  scope === undefined
    ? {}
    : { in: scope.threadId, ...(scope.scope === "everywhere" && { scope: "everywhere" as const }) };

/** The entries the Inbox lists: those about its chat or camp, unless it shows everywhere. */
export const inScope = (entries: ReadonlyArray<InboxEntry>, scope: InboxIn | undefined): ReadonlyArray<InboxEntry> =>
  scope === undefined || scope.scope === "everywhere"
    ? entries
    : entries.filter((entry) => entryThread(entry) === scope.threadId);

/**
 * Whether an entry still waits on you. Needs you keeps the one you decided in view, so its outcome
 * shows, but a decided request, share or proposal no longer counts as waiting.
 */
const entryWaits = (entry: InboxEntry): boolean => {
  switch (entry.kind) {
    case "approval":
      return entry.request.state === "pending";
    case "memory":
      return memoryShareWaits(entry.share);
    case "skill":
      return skillProposalOpen(entry.view.proposal);
    case "hob-proposal":
      return hobProposalOpen(entry.hobs.proposal);
    default:
      return true;
  }
};

/** How many of the entries the Inbox lists still wait on you. */
export const waitingIn = (entries: ReadonlyArray<InboxEntry>): number => entries.filter(entryWaits).length;
