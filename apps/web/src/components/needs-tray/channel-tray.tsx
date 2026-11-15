import type { Channel } from "@hobbots/domain";
import { SegmentedControl, SegmentedControlItem } from "@hobbots/ui/components/segmented-control";
import { Link } from "@tanstack/react-router";
import { type ReactNode, useState } from "react";
import { entryChannel } from "../inbox/inbox-entries.ts";
import { useInboxDirectory } from "../inbox/use-inbox-directory.ts";
import { messages } from "./messages.ts";
import { NeedsTray } from "./needs-tray.tsx";
import type { TrayEntry, TrayScope } from "./tray-entries.ts";
import { useChannelNeeds } from "./use-channel-needs.ts";

const copy = messages.scope;

/**
 * The Needs-you tray of a chat or camp (#1423): what is about this chat or camp, and with Everywhere,
 * what waits on you in every chat and camp, each item from elsewhere naming where it waits with a
 * link there. The choice shows while anything waits elsewhere, and stays while Everywhere is on;
 * when nothing waits here, a quiet line says how much waits elsewhere and keeps the choice in reach.
 * See all in Inbox opens the Inbox on this chat or camp.
 */
export function ChannelTray({ channel }: { channel: Channel }) {
  const [scope, setScope] = useState<TrayScope>("here");
  const needs = useChannelNeeds(channel.id);
  const directory = useInboxDirectory([]);
  const entries = needs[scope];
  const widens = needs.everywhere.length > needs.here.length || scope === "everywhere";
  const where = (entry: TrayEntry) => {
    const channelId = entryChannel(entry);
    if (channelId === null || channelId === channel.id) return null;
    const hobId = directory.channelHob(channelId);
    const line = copy.waitsIn({ place: directory.channelTitle(channelId) });
    if (hobId === undefined) return <span className="text-detail text-text-secondary">{line}</span>;
    return (
      <Link
        to="/hobs/$hobId/channels/$channelId"
        params={{ hobId, channelId }}
        className="self-start text-detail text-link underline underline-offset-2"
      >
        {line}
      </Link>
    );
  };
  const picker = (
    <SegmentedControl size="sm" aria-label={copy.label} value={scope} onValueChange={setScope}>
      <SegmentedControlItem value="here">{copy.here({ kind: channel.kind })}</SegmentedControlItem>
      <SegmentedControlItem value="everywhere">{copy.everywhere}</SegmentedControlItem>
    </SegmentedControl>
  );
  if (entries.length === 0) {
    const elsewhere = needs.everywhere.length;
    return elsewhere > 0 ? (
      <Elsewhere line={copy.elsewhere({ kind: channel.kind, count: elsewhere })} picker={picker} />
    ) : null;
  }
  return <NeedsTray entries={entries} where={where} inboxIn={channel.id} scope={widens && picker} />;
}

/** One quiet line above the composer: nothing waits here, this much waits elsewhere, and the way to it. */
function Elsewhere({ line, picker }: { line: string; picker: ReactNode }) {
  return (
    <section
      aria-label={copy.elsewhereLabel}
      className="flex flex-wrap items-center gap-2 rounded-card bg-panel px-3 py-1.5"
    >
      <span className="min-w-0 flex-1 text-detail text-text-secondary">{line}</span>
      {picker}
    </section>
  );
}
