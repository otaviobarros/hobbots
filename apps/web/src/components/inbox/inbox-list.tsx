import { Badge } from "@hobbots/ui/components/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@hobbots/ui/components/tabs";
import { cn } from "@hobbots/ui/lib/utils";
import { Link, useNavigate } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { HobSprite } from "../hob-sprite.tsx";
import {
  entryAsker,
  entryRow,
  entryThread,
  groupByThread,
  type InboxEntry,
  type InboxGroup,
  type RowTone,
} from "./inbox-entries.ts";
import { INBOX_TABS, type InboxTab } from "./inbox-items.ts";
import { messages } from "./messages.ts";
import type { InboxDirectory } from "./use-inbox-directory.ts";

const copy = messages;

/**
 * Needs you, All and History, with how many requests need you on the first, above the open tab's
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

/** The tab's entries, grouped by thread with this hub's devices apart; the selected one is filled. */
export function InboxList({
  tab,
  entries,
  selectedKey,
  directory,
  now,
}: {
  tab: InboxTab;
  entries: ReadonlyArray<InboxEntry>;
  selectedKey: string | undefined;
  directory: InboxDirectory;
  now: Date;
}) {
  return (
    <ul aria-label={copy.listLabel} className="m-0 flex list-none flex-col gap-3.5 p-0 px-2.5 py-1">
      {groupByThread(entries).map((group) => (
        <li key={group.threadId ?? "hub"} className="flex flex-col gap-1">
          <span className="lbl px-1.5 py-1 text-xs text-label">{groupLabel(group, directory)}</span>
          <ul className="m-0 flex list-none flex-col gap-1 p-0">
            {group.entries.map((entry) => (
              <li key={entry.key}>
                <InboxItem
                  tab={tab}
                  entry={entry}
                  selected={entry.key === selectedKey}
                  directory={directory}
                  now={now}
                />
              </li>
            ))}
          </ul>
        </li>
      ))}
    </ul>
  );
}

/** A group's heading: the hob whose chat the thread is, and the thread; or this hub's devices. */
const groupLabel = (group: InboxGroup, directory: InboxDirectory): string => {
  if (group.threadId === null) return copy.hubGroup;
  const first = group.entries[0];
  const owner = directory.threadHob(group.threadId) ?? (first === undefined ? undefined : entryAsker(first));
  return copy.group({
    name: owner === undefined ? copy.unknownHob : directory.hobName(owner),
    thread: directory.threadTitle(group.threadId),
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
  selected,
  directory,
  now,
}: {
  tab: InboxTab;
  entry: InboxEntry;
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
        selected ? "bg-card ring-2 ring-lantern ring-inset" : "hover:bg-hover",
        closed && "opacity-70",
      )}
    >
      <span className="mt-0.5 flex size-7.5 shrink-0 items-center justify-center rounded-tile bg-line text-text-secondary">
        {hob !== undefined ? (
          <HobSprite hob={hob} size={22} state={closed ? "idle" : "needs-you"} />
        ) : (
          entry.kind === "device" && <DeviceGlyph />
        )}
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-detail text-text-secondary">{row.who}</span>
          <Badge variant={row.tag}>{row.kind}</Badge>
        </span>
        <span className="text-sm leading-snug font-semibold [overflow-wrap:anywhere]">{row.what}</span>
        <span className={cn("text-xs", TONE[row.tone])}>{row.when}</span>
      </span>
    </Link>
  );
}

/** A screen on a stand, for a device asking to join. */
function DeviceGlyph() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 20 20"
      className="size-4.5"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
    >
      <path d="M3.5 5.5h13v8h-13zM1.5 15.5h17" strokeLinecap="round" />
    </svg>
  );
}
