import type { Agent, SnippetPart, Thread } from "@hobbots/domain";
import { Button } from "@hobbots/ui/components/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@hobbots/ui/components/menu";
import { cn } from "@hobbots/ui/lib/utils";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { useUnreadThreads } from "../../api/thread-reads.ts";
import { usePinThread, useRenameThread } from "../../api/thread-settings.ts";
import { formatWhen } from "../../lib/time.ts";
import { ArchiveItem } from "../archive/thread-menu.tsx";
import { cleanTitle } from "./chats-model.ts";
import { messages } from "./messages.ts";
import { QuestChip } from "./quest-chip.tsx";

const copy = messages.chats;

/** Text with the words that matched a search marked. */
function Marked({ parts }: { parts: ReadonlyArray<SnippetPart> }) {
  return parts.map((part, index) =>
    part.match ? (
      // biome-ignore lint/suspicious/noArrayIndexKey: the parts never reorder
      <mark key={index} className="rounded-[3px] bg-lantern/32 px-px text-text-strong">
        {part.text}
      </mark>
    ) : (
      part.text
    ),
  );
}

/**
 * One chat on a hob's page: its title, a matching message while searching, a chip when something in
 * it needs you and one for each Quest it follows, and its age, which gives way to the ⋯ menu on hover and focus. The menu renames it in
 * place, pins it to the top and archives it.
 */
export function ChatRow({
  hob,
  thread,
  live,
  needs,
  quests,
  title,
  snippet,
}: {
  hob: Agent;
  thread: Thread;
  live: boolean;
  /** How many approvals wait for you in it. */
  needs: number;
  /** The Quests followed in it, as their chips. */
  quests: ReadonlyArray<string>;
  /** The title with its matching words marked, while searching. */
  title?: ReadonlyArray<SnippetPart> | undefined;
  snippet?: ReadonlyArray<SnippetPart> | null | undefined;
}) {
  const [renaming, setRenaming] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const pinned = thread.pinnedAt !== null;
  const unread = useUnreadThreads().has(thread.id);
  const pin = usePinThread();

  return (
    <li className="group/row relative grid grid-cols-[16px_minmax(0,1fr)_auto] items-start gap-x-2.5 gap-y-1 border-t border-line py-3 ps-3 pe-3.5 transition-colors duration-(--dur-fade) first:border-t-0 hover:bg-hover">
      {!renaming && (
        <Link
          to="/hobs/$hobId/threads/$threadId"
          params={{ hobId: hob.id, threadId: thread.id }}
          aria-label={copy.open({ title: thread.title })}
          className="absolute inset-0 focus-ring focus-inset"
        />
      )}
      <span className="flex h-[22px] items-center justify-center text-label">
        {live ? (
          <span role="img" aria-label={copy.working} className="size-2 flex-none rounded-dot bg-mint" />
        ) : unread ? (
          // The hob wrote since you read the chat on any device of yours (ADR 027, ADR 039).
          <span role="img" aria-label={copy.unread} className="size-2 flex-none rounded-dot bg-lantern" />
        ) : (
          pinned && <PinIcon label={copy.pinned} />
        )}
      </span>
      <span className="pointer-events-none flex min-w-0 flex-col gap-0.5">
        {renaming ? (
          <RenameField
            thread={thread}
            onDone={() => setRenaming(false)}
            className="pointer-events-auto relative z-[1]"
          />
        ) : (
          <span title={thread.title} className="truncate text-[15px] leading-[22px] font-semibold text-text-strong">
            {title ? <Marked parts={title} /> : thread.title}
          </span>
        )}
        {/* While searching, where the words matched; otherwise the chat's last line. */}
        {snippet ? (
          <span className="truncate text-ui leading-5 text-text-secondary">
            <Marked parts={snippet} />
          </span>
        ) : (
          thread.lastLine && (
            <span title={thread.lastLine} className="truncate text-ui leading-5 text-text-secondary">
              {thread.lastLine}
            </span>
          )
        )}
        {(needs > 0 || quests.length > 0) && (
          <span className="flex min-w-0 flex-wrap gap-1.5 pt-1">
            {needs > 0 && (
              <span className="rounded-tag bg-lantern px-2 py-px text-meta leading-[18px] font-semibold whitespace-nowrap text-on-lantern">
                {copy.needs({ count: needs })}
              </span>
            )}
            {quests.map((quest) => (
              <QuestChip key={quest} label={quest} />
            ))}
          </span>
        )}
      </span>
      <span
        className={cn(
          "pointer-events-none text-meta leading-[22px] whitespace-nowrap text-label group-focus-within/row:invisible group-hover/row:invisible",
          menuOpen && "invisible",
        )}
      >
        {formatWhen(thread.updatedAt)}
      </span>
      <DropdownMenu onOpenChange={setMenuOpen}>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            aria-label={copy.menu({ title: thread.title })}
            title={copy.menu({ title: thread.title })}
            className={cn(
              // It shows when the row is hovered, on the row's own hover fill; only hovering it fills it.
              "absolute end-2 top-2 text-text-secondary opacity-0 group-focus-within/row:opacity-100 group-hover/row:opacity-100 hover:bg-line hover:text-text-strong focus-visible:opacity-100 data-[state=open]:bg-line data-[state=open]:text-text-strong",
              menuOpen && "opacity-100",
            )}
          >
            ⋯
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={() => setRenaming(true)}>{copy.rename}</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => pin.mutate({ thread, value: !pinned })}>
            {pinned ? copy.unpin : copy.pin}
          </DropdownMenuItem>
          <ArchiveItem Item={DropdownMenuItem} hob={hob} thread={thread} current={false} open={menuOpen} />
        </DropdownMenuContent>
      </DropdownMenu>
    </li>
  );
}

/** The title as a field: Enter or leaving it saves, Esc keeps the old title. The chat header uses it too. */
export function RenameField({ thread, onDone, className }: { thread: Thread; onDone: () => void; className?: string }) {
  const [typed, setTyped] = useState(thread.title);
  const rename = useRenameThread();
  const save = () => {
    const title = cleanTitle(typed);
    if (title !== null && title !== thread.title) rename.mutate({ thread, value: title });
    onDone();
  };
  return (
    <input
      // biome-ignore lint/a11y/noAutofocus: the field opens from the menu's Rename, to type in at once
      autoFocus
      value={typed}
      aria-label={copy.renameLabel({ title: thread.title })}
      onChange={(event) => setTyped(event.target.value)}
      onFocus={(event) => event.currentTarget.select()}
      onBlur={save}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          event.currentTarget.blur();
        } else if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          setTyped(thread.title);
          onDone();
        }
      }}
      className={cn(
        "-my-px min-w-0 border-(length:--edge) border-ring bg-deep px-1.5 text-[15px] leading-[22px] font-semibold text-text-strong outline-none",
        className,
      )}
    />
  );
}

/** The lantern pin beside a chat pinned to the top. */
export function PinIcon({ label }: { label: string }) {
  return (
    <svg
      role="img"
      aria-label={label}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="size-4 text-lantern"
    >
      <path d="M6 2h4l-.5 4 2.5 2.5H4L6.5 6z" />
      <path d="M8 8.5V14" />
    </svg>
  );
}
