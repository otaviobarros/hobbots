import type { Agent, Thread } from "@hobbots/domain";
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
import { useThreadBrain } from "../providers/brain-picker.tsx";
import { useArchive } from "./archive-context.tsx";
import { isMac } from "./archive-rules.ts";
import { messages as copy } from "./messages.ts";
import { CampItems, HobItems, Line, ThreadItems } from "./thread-menu-items.tsx";
import { useArchiveBlock } from "./use-archive-block.ts";

const brainCopy = appCopy.brain;

type MenuItem = ComponentType<{
  disabled?: boolean;
  onSelect?: () => void;
  textValue?: string;
  children?: ReactNode;
}>;

/**
 * Archive chat, as a menu item. While the thread cannot be archived it stays in the menu,
 * disabled, and reads its reason. `current` shows the shortcut, which acts on the open thread.
 */
export function ArchiveItem({
  Item,
  hob,
  thread,
  current,
  open,
  icon,
}: {
  Item: MenuItem;
  hob: Agent;
  thread: Thread;
  current: boolean;
  open: boolean;
  /** The box drawn before the label, in the header's menu. */
  icon?: ReactNode;
}) {
  const { archive } = useArchive();
  const block = useArchiveBlock(thread.id, open);
  return (
    <Item disabled={block !== null} textValue={copy.archive} onSelect={() => archive(hob, thread)}>
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

/** Export, then Archive chat after a divider, for a thread that exists. */
function EndItems({
  hob,
  thread,
  open,
  onExport,
}: {
  hob: Agent;
  thread: Thread;
  open: boolean;
  onExport: () => void;
}) {
  return (
    <>
      <DropdownMenuItem onSelect={onExport}>
        <Line icon={<ExportIcon />}>{exportCopy.menuThread}</Line>
      </DropdownMenuItem>
      <DropdownMenuSeparator />
      <ArchiveItem Item={RoseItem} hob={hob} thread={thread} current open={open} icon={<ArchiveMenuIcon />} />
    </>
  );
}

/**
 * What the chat thinks with and whether it is ready; choosing it opens the brain picker. Before the
 * thread exists it stays in the menu, disabled, and says when the brain can change.
 */
function BrainItem({ hob, thread, onSelect }: { hob: Agent; thread: Thread | undefined; onSelect: () => void }) {
  const brain = useThreadBrain(hob, thread);
  return (
    <DropdownMenuItem
      aria-label={thread && brainCopy.trigger({ brain: brain.label, state: brain.state })}
      textValue={brainCopy.change}
      disabled={thread === undefined}
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
      {thread === undefined && <span className="ps-6 text-meta">{brainCopy.freshPage}</span>}
    </DropdownMenuItem>
  );
}

/**
 * The chat header's ⋯ menu: rename a camp in the header, pin it to the top of its hob's
 * chats, search it, make a camp, start the hob's chat fresh, change the brain it thinks with, open its hob's page or profile, export it, or
 * archive it. On the fresh page, before the thread exists, it keeps the hob's page and profile, and
 * says when the brain can change.
 */
export function ThreadHeaderMenu({
  hob,
  thread,
  onRename,
  onSearch,
  onBrain,
  onMakeCamp,
  onStartFresh,
}: {
  hob: Agent;
  thread: Thread | undefined;
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
          {thread && <ThreadItems thread={thread} onRename={moveTo(onRename)} onSearch={moveTo(onSearch)} />}
          <CampItems thread={thread} onMakeCamp={moveTo(onMakeCamp)} onStartFresh={moveTo(onStartFresh)} />
          <BrainItem hob={hob} thread={thread} onSelect={moveTo(onBrain)} />
          <HobItems hob={hob} />
          {thread && <EndItems hob={hob} thread={thread} open={open} onExport={() => setExporting(true)} />}
        </DropdownMenuContent>
      </DropdownMenu>
      {thread && exporting && <ExportDialog target={{ thread }} onClose={() => setExporting(false)} />}
    </>
  );
}
