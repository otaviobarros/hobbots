import type { Quest, TaskId } from "@hobbots/domain";
import { Badge } from "@hobbots/ui/components/badge";
import { SegmentedControl, SegmentedControlItem } from "@hobbots/ui/components/segmented-control";
import { cn } from "@hobbots/ui/lib/utils";
import { Link } from "@tanstack/react-router";
import type { RefObject } from "react";
import { firstLine } from "../../lib/format.ts";
import { FlagIcon } from "../quest/flag-icon.tsx";
import { EntryPortrait } from "./entry-portrait.tsx";
import {
  entryAsker,
  entryPlace,
  entryRow,
  entryThread,
  groupByPlace,
  type InboxEntry,
  type InboxGroup,
  type InboxPlace,
  type RowTone,
} from "./inbox-entries.ts";
import { InboxIcon } from "./inbox-icons.tsx";
import { INBOX_VIEWS, type InboxTab, type InboxView } from "./inbox-items.ts";
import { shownOrder } from "./inbox-keys.ts";
import { messages } from "./messages.ts";
import type { InboxDirectory } from "./use-inbox-directory.ts";

const copy = messages;

/**
 * The entries, by quest or by urgency. By quest groups them by quest, or by thread outside a quest,
 * with this hub's devices apart, the most urgent first in each group and among the groups. By
 * urgency is one list, the most urgent first, and each row names its quest. The selected one is
 * filled, and it is the list's one stop for Tab: ↑ and ↓ move from there (`useListKeys`).
 */
export function InboxList({
  tab,
  view,
  entries,
  questOf,
  selectedKey,
  directory,
  now,
  listRef,
}: {
  tab: InboxTab;
  view: InboxView;
  entries: ReadonlyArray<InboxEntry>;
  questOf: (taskId: TaskId) => Quest | undefined;
  selectedKey: string | undefined;
  directory: InboxDirectory;
  now: Date;
  listRef: RefObject<HTMLUListElement | null>;
}) {
  const order = shownOrder(entries, view, questOf);
  const tabStop = order.some((entry) => entry.key === selectedKey) ? selectedKey : order[0]?.key;
  const item = (entry: InboxEntry, place?: string) => (
    <li key={entry.key}>
      <InboxItem
        tab={tab}
        entry={entry}
        place={place}
        selected={entry.key === selectedKey}
        tabStop={entry.key === tabStop}
        directory={directory}
        now={now}
      />
    </li>
  );
  if (view === "urgency") {
    return (
      <ul ref={listRef} aria-label={copy.listLabel} className="m-0 flex list-none flex-col gap-1 p-0 px-2.5 py-1">
        {order.map((entry) => item(entry, placeName(entryPlace(entry, questOf), directory)))}
      </ul>
    );
  }
  return (
    <ul ref={listRef} aria-label={copy.listLabel} className="m-0 flex list-none flex-col gap-3.5 p-0 px-2.5 py-1">
      {groupByPlace(entries, questOf).map((group) => {
        const heading = groupHeading(group, directory);
        return (
          <li key={group.key} className="flex flex-col gap-1 rounded-card bg-card px-1 pt-1 pb-1">
            <span title={copy.groupTitle(heading)} className="flex min-w-0 items-center gap-1.5 px-1.5 py-1">
              <span className="flex text-star">
                {heading.icon === "quest" ? <FlagIcon size={13} /> : <InboxIcon name={heading.icon} size={13} />}
              </span>
              <span className="lbl flex-none text-meta text-label">{heading.label}</span>
              <span className="min-w-0 truncate text-meta text-label">{heading.detail}</span>
            </span>
            <ul className="m-0 flex list-none flex-col gap-1 p-0">{group.entries.map((entry) => item(entry))}</ul>
          </li>
        );
      })}
    </ul>
  );
}

/** By quest or By urgency, above the list in Needs you. */
export function InboxViewPicker({ view, onChange }: { view: InboxView; onChange: (view: InboxView) => void }) {
  return (
    <div className="flex items-center gap-2 px-4 pt-2.5 pb-1.5">
      <span className="flex-1 text-meta text-label">{copy.view.label}</span>
      <SegmentedControl size="sm" aria-label={copy.view.label} value={view} onValueChange={onChange}>
        {INBOX_VIEWS.map((name) => (
          <SegmentedControlItem key={name} value={name}>
            {copy.view[name]}
          </SegmentedControlItem>
        ))}
      </SegmentedControl>
    </div>
  );
}

/** Where an entry belongs, in a few words, for a row in By urgency: "Aldric's quest". */
const placeName = (place: InboxPlace, directory: InboxDirectory): string => {
  if (place.kind === "hub") return copy.hub;
  if (place.kind === "quest") return copy.questName({ name: directory.hobName(place.quest.leadId) });
  return directory.threadTitle(place.threadId);
};

/**
 * A group's heading: a short label with its icon, then the detail. A quest is its lead's quest and
 * its goal, a thread outside a quest whose chat it is and its title, and this hub its devices.
 */
const groupHeading = (
  { place, entries }: InboxGroup,
  directory: InboxDirectory,
): { readonly icon: "quest" | "chat" | "screen"; readonly label: string; readonly detail: string } => {
  if (place.kind === "hub") return { icon: "screen", label: copy.hub, detail: copy.devices };
  if (place.kind === "quest") {
    return {
      icon: "quest",
      label: copy.questName({ name: directory.hobName(place.quest.leadId) }),
      detail: firstLine(place.quest.goal),
    };
  }
  const first = entries[0];
  const owner = directory.threadHob(place.threadId) ?? (first === undefined ? undefined : entryAsker(first));
  return {
    icon: "chat",
    label: owner === undefined ? copy.unknownHob : directory.hobName(owner),
    detail: directory.threadTitle(place.threadId),
  };
};

const TONE: Record<RowTone, string> = { urgent: "text-lantern", stuck: "text-rose", plain: "text-text-secondary" };

/**
 * One entry as a row, the same for every kind: who asked as a chain, the kind, what it is about and
 * when. It opens the entry beside the list.
 */
function InboxItem({
  tab,
  entry,
  place,
  selected,
  tabStop,
  directory,
  now,
}: {
  tab: InboxTab;
  entry: InboxEntry;
  /** Where it belongs, named in a row of the By urgency list. */
  place?: string | undefined;
  selected: boolean;
  /** Whether Tab stops on this row: the selected one, or the first while none is. */
  tabStop: boolean;
  directory: InboxDirectory;
  now: Date;
}) {
  const thread = entryThread(entry);
  const row = entryRow(entry, directory.hobName, thread === null ? undefined : directory.threadHob(thread), now);
  const asker = entryAsker(entry);
  const hob = asker === undefined ? undefined : directory.hob(asker);
  const closed = entry.kind === "approval" && entry.request.state !== "pending";
  return (
    <Link
      to="/inbox"
      search={{ tab, request: entry.key }}
      aria-current={selected ? "page" : undefined}
      tabIndex={tabStop ? 0 : -1}
      data-entry={entry.key}
      activeOptions={{ exact: true, includeSearch: true }}
      data-kind={entry.kind}
      data-state={entry.kind === "approval" ? entry.request.state : undefined}
      className={cn(
        "hop-on-hover flex w-full items-start gap-2.5 rounded-control p-2.5 text-start text-text-strong no-underline transition-colors hover:text-text-strong",
        selected ? "bg-lantern/10 text-text-strong" : "hover:bg-hover",
        closed && "opacity-70",
      )}
    >
      <EntryPortrait hob={hob} device={entry.kind === "device"} waiting={!closed} />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-detail text-text-secondary">
            {row.chain.join(copy.row.arrow)}
          </span>
          <Badge variant={row.tag}>{row.kind}</Badge>
        </span>
        <span title={row.what} className="truncate text-ui font-semibold">
          {row.what}
        </span>
        <span className={cn("flex items-center gap-1.25 text-meta", TONE[row.tone])}>
          <InboxIcon name="clock" size={12} />
          {place === undefined ? row.when : copy.whenIn({ when: row.when, place })}
        </span>
      </span>
    </Link>
  );
}
