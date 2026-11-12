import type { Thread } from "@hobbots/domain";
import { SegmentedControl, SegmentedControlItem } from "@hobbots/ui/components/segmented-control";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { entryThread } from "../inbox/inbox-entries.ts";
import { useInboxDirectory } from "../inbox/use-inbox-directory.ts";
import { messages } from "./messages.ts";
import { NeedsTray } from "./needs-tray.tsx";
import type { TrayEntry, TrayScope } from "./tray-entries.ts";
import { useThreadNeeds } from "./use-thread-needs.ts";

const copy = messages.scope;

/**
 * The Needs-you tray of a chat or camp (#1423): what is about this chat or camp, and with Everywhere,
 * what waits on you in every chat and camp, each item from elsewhere naming where it waits with a
 * link there. The choice shows while anything waits elsewhere, and stays while Everywhere is on.
 * See all in Inbox opens the Inbox on this chat or camp.
 */
export function ThreadTray({ thread }: { thread: Thread }) {
  const [scope, setScope] = useState<TrayScope>("here");
  const needs = useThreadNeeds(thread.id);
  const directory = useInboxDirectory([]);
  const entries = needs[scope];
  const widens = needs.everywhere.length > needs.here.length || scope === "everywhere";
  const where = (entry: TrayEntry) => {
    const threadId = entryThread(entry);
    if (threadId === null || threadId === thread.id) return null;
    const hobId = directory.threadHob(threadId);
    const line = copy.waitsIn({ place: directory.threadTitle(threadId) });
    if (hobId === undefined) return <span className="text-detail text-text-secondary">{line}</span>;
    return (
      <Link
        to="/hobs/$hobId/threads/$threadId"
        params={{ hobId, threadId }}
        className="self-start text-detail text-link underline underline-offset-2"
      >
        {line}
      </Link>
    );
  };
  return (
    <NeedsTray
      entries={entries}
      where={where}
      inboxIn={thread.id}
      scope={
        widens && (
          <SegmentedControl size="sm" aria-label={copy.label} value={scope} onValueChange={setScope}>
            <SegmentedControlItem value="here">{copy.here({ kind: thread.kind })}</SegmentedControlItem>
            <SegmentedControlItem value="everywhere">{copy.everywhere}</SegmentedControlItem>
          </SegmentedControl>
        )
      }
    />
  );
}
