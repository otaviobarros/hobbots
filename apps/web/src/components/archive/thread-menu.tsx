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
function ArchiveItem({
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

/**
 * A thread row in the hob panel with its menu: a ⋯ button that shows on hover and focus, and the
 * same menu on right-click, Shift+F10 or the context-menu key.
 */
export function ThreadRowMenu({
  hob,
  thread,
  current,
  children,
}: {
  hob: Agent;
  thread: Thread;
  current: boolean;
  /** The row's link. */
  children: ReactNode;
}) {
  const [contextOpen, setContextOpen] = useState(false);
  const [buttonOpen, setButtonOpen] = useState(false);
  return (
    <ContextMenu onOpenChange={setContextOpen}>
      <ContextMenuTrigger asChild>
        <div className="group relative flex">
          {children}
          <DropdownMenu onOpenChange={setButtonOpen}>
            <DropdownMenuTrigger asChild>
              <Button
                variant="icon"
                size="icon"
                aria-label={copy.threadMenu({ title: thread.title })}
                title={copy.threadMenu({ title: thread.title })}
                className={cn(
                  "absolute end-1.5 top-1/2 size-6 -translate-y-1/2 bg-panel opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 focus-visible:opacity-100",
                  buttonOpen && "opacity-100",
                )}
              >
                ⋯
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              <ArchiveItem Item={DropdownMenuItem} hob={hob} thread={thread} current={current} open={buttonOpen} />
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ArchiveItem Item={ContextMenuItem} hob={hob} thread={thread} current={current} open={contextOpen} />
      </ContextMenuContent>
    </ContextMenu>
  );
}

/** The chat header's ⋯ menu for the open thread. */
export function ThreadHeaderMenu({ hob, thread }: { hob: Agent; thread: Thread }) {
  const [open, setOpen] = useState(false);
  return (
    <DropdownMenu onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button variant="icon" size="icon" aria-label={copy.headerMenu} title={copy.headerMenu}>
          ⋯
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <ArchiveItem Item={DropdownMenuItem} hob={hob} thread={thread} current open={open} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
