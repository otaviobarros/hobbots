import type { Quest, TaskId } from "@hobbots/domain";
import { Badge } from "@hobbots/ui/components/badge";
import { SegmentedControl, SegmentedControlItem } from "@hobbots/ui/components/segmented-control";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@hobbots/ui/components/tabs";
import { cn } from "@hobbots/ui/lib/utils";
import { Link, useNavigate } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { firstLine } from "../../lib/format.ts";
import { EntryPortrait } from "./entry-portrait.tsx";
import {
  byUrgency,
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
import { INBOX_TABS, INBOX_VIEWS, type InboxTab, type InboxView } from "./inbox-items.ts";
import { messages } from "./messages.ts";
import type { InboxDirectory } from "./use-inbox-directory.ts";

const copy = messages;

/**
 * Needs you and History, with how many things need you on the first, above the open tab's
 * panel. The tab is in the address.
 */
export function InboxTabs({ tab, waiting, children }: { tab: InboxTab; waiting: number; children: ReactNode }) {
  const navigate = useNavigate();
  // Opens a tab. Clicking the open tab again lands here too, so the request shown leaves the address.
  const open = (next: string) => {
    const name = INBOX_TABS.find((each) => each === next);
    if (name !== undefined) void navigate({ to: "/inbox", search: { tab: name } });
  };
  return (
    <Tabs value={tab} onValueChange={open} className="min-h-0 flex-1">
      <TabsList aria-label={copy.tabsLabel} className="px-2.5 pt-2">
        {INBOX_TABS.map((name) => (
          <TabsTrigger key={name} value={name} onClick={() => name === tab && open(name)}>
            {copy.tabs[name]}
            {name === "needs" && waiting > 0 && <Badge variant="needs-you">{copy.count({ count: waiting })}</Badge>}
          </TabsTrigger>
        ))}
      </TabsList>
      <TabsContent value={tab} className="min-h-0 flex-1 overflow-y-auto">
        {children}
      </TabsContent>
    </Tabs>
  );
}

/**
 * The entries, by quest or by urgency. By quest groups them by quest, or by thread outside a quest,
 * with this hub's devices apart, the most urgent first in each group and among the groups. By
 * urgency is one list, the most urgent first, and each row names its quest. The selected one is
 * filled.
 */
export function InboxList({
  tab,
  view,
  entries,
  questOf,
  selectedKey,
  directory,
  now,
}: {
  tab: InboxTab;
  view: InboxView;
  entries: ReadonlyArray<InboxEntry>;
  questOf: (taskId: TaskId) => Quest | undefined;
  selectedKey: string | undefined;
  directory: InboxDirectory;
  now: Date;
}) {
  const item = (entry: InboxEntry, place?: string) => (
    <li key={entry.key}>
      <InboxItem
        tab={tab}
        entry={entry}
        place={place}
        selected={entry.key === selectedKey}
        directory={directory}
        now={now}
      />
    </li>
  );
  if (view === "urgency") {
    return (
      <ul aria-label={copy.listLabel} className="m-0 flex list-none flex-col gap-1 p-0 px-2.5 py-1">
        {[...entries].sort(byUrgency).map((entry) => item(entry, placeName(entryPlace(entry, questOf), directory)))}
      </ul>
    );
  }
  return (
    <ul aria-label={copy.listLabel} className="m-0 flex list-none flex-col gap-3.5 p-0 px-2.5 py-1">
      {groupByPlace(entries, questOf).map((group) => {
        const label = groupLabel(group, directory);
        return (
          <li key={group.key} className="flex flex-col gap-1">
            <span title={label} className="lbl truncate px-1.5 py-1 text-xs text-label">
              {label}
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
      <span className="flex-1 text-xs text-label">{copy.view.label}</span>
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

/** A group's heading: the quest and its lead, the thread and whose chat it is, or this hub's devices. */
const groupLabel = ({ place, entries }: InboxGroup, directory: InboxDirectory): string => {
  if (place.kind === "hub") return copy.hubGroup;
  if (place.kind === "quest") {
    return copy.questGroup({ name: directory.hobName(place.quest.leadId), goal: firstLine(place.quest.goal) });
  }
  const first = entries[0];
  const owner = directory.threadHob(place.threadId) ?? (first === undefined ? undefined : entryAsker(first));
  return copy.group({
    name: owner === undefined ? copy.unknownHob : directory.hobName(owner),
    thread: directory.threadTitle(place.threadId),
  });
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
  directory,
  now,
}: {
  tab: InboxTab;
  entry: InboxEntry;
  /** Where it belongs, named in a row of the By urgency list. */
  place?: string | undefined;
  selected: boolean;
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
      activeOptions={{ exact: true, includeSearch: true }}
      data-kind={entry.kind}
      data-state={entry.kind === "approval" ? entry.request.state : undefined}
      className={cn(
        "hop-on-hover flex w-full items-start gap-2.5 rounded-control p-2.5 text-start text-text-strong no-underline transition-colors hover:text-text-strong",
        selected ? "bg-card text-text-strong" : "hover:bg-hover",
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
        <span className="text-sm leading-snug font-semibold [overflow-wrap:anywhere]">{row.what}</span>
        <span className={cn("text-xs", TONE[row.tone])}>
          {place === undefined ? row.when : copy.whenIn({ when: row.when, place })}
        </span>
      </span>
    </Link>
  );
}
