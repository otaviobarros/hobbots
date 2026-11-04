import type { Agent, Thread } from "@hobbots/domain";
import { Button } from "@hobbots/ui/components/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  MenuShortcut,
} from "@hobbots/ui/components/menu";
import { cn } from "@hobbots/ui/lib/utils";
import { type ComponentType, type ReactNode, useState } from "react";
import { ExportDialog } from "../export/export-dialog.tsx";
import { messages as exportCopy } from "../export/messages.ts";
import { useArchive } from "./archive-context.tsx";
import { isMac } from "./archive-rules.ts";
import { messages as copy } from "./messages.ts";
import { useArchiveBlock } from "./use-archive-block.ts";

type MenuItem = ComponentType<{
  disabled?: boolean;
  onSelect?: () => void;
  textValue?: string;
  children?: ReactNode;
}>;

/**
 * Archive thread, as a menu item. While the thread cannot be archived it stays in the menu,
 * disabled, and reads its reason. `current` shows the shortcut, which acts on the open thread.
 */
export function ArchiveItem({
  Item,
  hob,
  thread,
  current,
  open,
}: {
  Item: MenuItem;
  hob: Agent;
  thread: Thread;
  current: boolean;
  open: boolean;
}) {
  const { archive } = useArchive();
  const block = useArchiveBlock(thread.id, open);
  return (
    <Item disabled={block !== null} textValue={copy.archive} onSelect={() => archive(hob, thread)}>
      <span className="flex items-center gap-3">
        <span>{copy.archive}</span>
        {current && <MenuShortcut>{copy.archiveShortcut({ mac: isMac() })}</MenuShortcut>}
      </span>
      {block !== null && <span className="text-xs">{copy.blocked[block]({ name: hob.name })}</span>}
    </Item>
  );
}

/** The chat header's ⋯ menu for the open thread: export it, or archive it. */
export function ThreadHeaderMenu({ hob, thread }: { hob: Agent; thread: Thread }) {
  const [open, setOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
  return (
    <>
      <DropdownMenu onOpenChange={setOpen}>
        <DropdownMenuTrigger asChild>
          <Button variant="icon" size="icon" aria-label={copy.headerMenu} title={copy.headerMenu}>
            ⋯
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={() => setExporting(true)}>{exportCopy.menuThread}</DropdownMenuItem>
          <ArchiveItem Item={DropdownMenuItem} hob={hob} thread={thread} current open={open} />
        </DropdownMenuContent>
      </DropdownMenu>
      {exporting && <ExportDialog target={{ thread }} onClose={() => setExporting(false)} />}
    </>
  );
}
