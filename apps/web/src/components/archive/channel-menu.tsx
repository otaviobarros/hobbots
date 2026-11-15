import type { Agent, Channel } from "@hobbots/domain";
import { Button } from "@hobbots/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  MenuShortcut,
} from "@hobbots/ui/components/menu";
import { Skeleton } from "@hobbots/ui/components/skeleton";
import { cn } from "@hobbots/ui/lib/utils";
import { type ComponentType, type ReactNode, useRef, useState } from "react";
import { ArchiveMenuIcon, ExportIcon, SparkIcon } from "../chat/chat-icons.tsx";
import { ExportDialog } from "../export/export-dialog.tsx";
import { messages as exportCopy } from "../export/messages.ts";
import { messages as appCopy } from "../messages.ts";
import { useChannelBrain } from "../providers/brain-picker.tsx";
import { useArchive } from "./archive-context.tsx";
import { isMac } from "./archive-rules.ts";
import { messages as copy } from "./messages.ts";
import { CampItems, HobItems, Line, ChannelItems } from "./channel-menu-items.tsx";
import { useArchiveBlock } from "./use-archive-block.ts";

const brainCopy = appCopy.brain;

type MenuItem = ComponentType<{
  disabled?: boolean;
  onSelect?: () => void;
  textValue?: string;
  children?: ReactNode;
}>;

/**
 * Archive chat, as a menu item. While the channel cannot be archived it stays in the menu,
 * disabled, and reads its reason. `current` shows the shortcut, which acts on the open channel.
 */
export function ArchiveItem({
  Item,
  hob,
  channel,
  current,
  open,
  icon,
}: {
  Item: MenuItem;
  hob: Agent;
  channel: Channel;
  current: boolean;
  open: boolean;
  /** The box drawn before the label, in the header's menu. */
  icon?: ReactNode;
}) {
  const { archive } = useArchive();
  const block = useArchiveBlock(channel.id, open);
  return (
    <Item disabled={block !== null} textValue={copy.archive} onSelect={() => archive(hob, channel)}>
      <span className="flex items-center gap-2.5">
        {icon}
        <span className="me-0.5">{copy.archive}</span>
        {current && <MenuShortcut>{copy.archiveShortcut({ mac: isMac() })}</MenuShortcut>}
      </span>
      {block !== null && <span className="text-meta">{copy.blocked[block]({ name: hob.name })}</span>}
    </Item>
  );
}

/** Archive in the header's menu reads in rose, as the one item that takes the chat away. */
const RoseItem: MenuItem = (props) => <DropdownMenuItem {...props} className="text-rose focus:text-rose" />;

/** Export, then Archive chat after a divider, for a channel that exists. */
function EndItems({
  hob,
  channel,
  open,
  onExport,
}: {
  hob: Agent;
  channel: Channel;
  open: boolean;
  onExport: () => void;
}) {
  return (
    <>
      <DropdownMenuItem onSelect={onExport}>
        <Line icon={<ExportIcon />}>{exportCopy.menuChannel}</Line>
      </DropdownMenuItem>
      <DropdownMenuSeparator />
      <ArchiveItem Item={RoseItem} hob={hob} channel={channel} current open={open} icon={<ArchiveMenuIcon />} />
    </>
  );
}

/**
 * What the chat thinks with and whether it is ready; choosing it opens the brain picker. Before the
 * channel exists it stays in the menu, disabled, and says when the brain can change.
 */
function BrainItem({ hob, channel, onSelect }: { hob: Agent; channel: Channel | undefined; onSelect: () => void }) {
  const brain = useChannelBrain(hob, channel);
  return (
    <DropdownMenuItem
      aria-label={channel && brainCopy.trigger({ brain: brain.label, state: brain.state })}
      textValue={brainCopy.change}
      disabled={channel === undefined}
      onSelect={onSelect}
    >
      <Line icon={<SparkIcon />}>{brainCopy.change}</Line>
      <span className="ps-6 text-meta">
        {brain.label} ·{" "}
        {brain.checking ? (
          <Skeleton width="7ch" />
        ) : (
          <span className={cn(brain.ready ? "text-mint" : "text-lantern")}>{brain.state}</span>
        )}
      </span>
      {channel === undefined && <span className="ps-6 text-meta">{brainCopy.freshPage}</span>}
    </DropdownMenuItem>
  );
}

/**
 * The chat header's ⋯ menu: rename a camp in the header, pin it to the top of its hob's
 * chats, search it, make a camp, start the hob's chat fresh, change the brain it thinks with, open its hob's page or profile, export it, or
 * archive it. On the fresh page, before the channel exists, it keeps the hob's page and profile, and
 * says when the brain can change.
 */
export function ChannelHeaderMenu({
  hob,
  channel,
  onRename,
  onSearch,
  onBrain,
  onMakeCamp,
  onStartFresh,
}: {
  hob: Agent;
  channel: Channel | undefined;
  onRename: () => void;
  onSearch: () => void;
  /** Opens the brain picker beside ⋯. */
  onBrain: () => void;
  /** Opens the Make a camp sheet. */
  onMakeCamp: () => void;
  /** Opens the Start fresh sheet, offered on the hob's open chat. */
  onStartFresh: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
  // Rename, Search and the brain picker move focus away from ⋯: they open once the menu has closed,
  // in place of handing focus back to it.
  const handOff = useRef<(() => void) | null>(null);
  const moveTo = (action: () => void) => () => {
    handOff.current = action;
  };
  return (
    <>
      <DropdownMenu onOpenChange={setOpen}>
        <DropdownMenuTrigger asChild>
          <Button variant="icon" size="icon" aria-label={copy.headerMenu} title={copy.headerMenu}>
            ⋯
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          onCloseAutoFocus={(event) => {
            const action = handOff.current;
            handOff.current = null;
            if (action === null) return;
            event.preventDefault();
            action();
          }}
        >
          {channel && <ChannelItems channel={channel} onRename={moveTo(onRename)} onSearch={moveTo(onSearch)} />}
          <CampItems channel={channel} onMakeCamp={moveTo(onMakeCamp)} onStartFresh={moveTo(onStartFresh)} />
          <BrainItem hob={hob} channel={channel} onSelect={moveTo(onBrain)} />
          <HobItems hob={hob} />
          {channel && <EndItems hob={hob} channel={channel} open={open} onExport={() => setExporting(true)} />}
        </DropdownMenuContent>
      </DropdownMenu>
      {channel && exporting && <ExportDialog target={{ channel }} onClose={() => setExporting(false)} />}
    </>
  );
}
