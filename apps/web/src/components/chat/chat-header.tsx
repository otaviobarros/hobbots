import type { Agent, AgentId, Thread, ThreadId } from "@hobbots/domain";
import { Button } from "@hobbots/ui/components/button";
import { Link } from "@tanstack/react-router";
import { type ReactNode, useState } from "react";
import { ThreadHeaderMenu } from "../archive/thread-menu.tsx";
import { CampSheet } from "../camp-sheet/camp-sheet.tsx";
import { messages as sheetCopy } from "../camp-sheet/messages.ts";
import { MakeCampSheet } from "../camps/make-camp-sheet.tsx";
import { messages as campCopy } from "../camps/messages.ts";
import { StartFreshSheet } from "../camps/start-fresh-sheet.tsx";
import { FocusChip } from "../chapters/focus-chip.tsx";
import { ChatSearchButton } from "../chat-search/chat-search.tsx";
import { HobSprite, type HobState } from "../hob-sprite/hob-sprite.tsx";
import { messages } from "../messages.ts";
import { BrainPicker } from "../providers/brain-picker.tsx";
import { ThreadQuestButton } from "../quest/thread-work.tsx";
import type { Pins } from "../quest/use-work.ts";
import { BackIcon } from "./chat-icons.tsx";
import { ChatTitle } from "./chat-title.tsx";

const copy = messages.chat;
const headerCopy = campCopy.header;

/** Which sheet the header opened: from its menu, or a camp's own sheet. */
type Sheet = "make-camp" | "start-fresh" | "camp" | null;

/**
 * The chat's header (ADR 037, A2-02). The hob's chat leads with the hob's name over "Your chat with"
 * it; a camp leads with its title over who leads it, with its goal under. Then the quest button,
 * search and the ⋯ menu, where Make a camp and Start a fresh chat open their sheets.
 */
export function ChatHeader({
  hob,
  hobId,
  threadId,
  thread,
  state,
  doing,
  pins,
  finding,
  onFinding,
  headerEnd,
}: {
  hob: Agent;
  hobId: AgentId;
  threadId: ThreadId | undefined;
  /** The thread, or undefined on the empty chat before its first message makes it. */
  thread: Thread | undefined;
  state: HobState;
  /** What the hob is doing, as the line under the title says it. */
  doing: string;
  pins: Pins;
  finding: boolean;
  onFinding: (open: boolean) => void;
  headerEnd: ReactNode;
}) {
  const [renamingIn, setRenamingIn] = useState<string>();
  const renaming = threadId !== undefined && renamingIn === threadId;
  const [sheet, setSheet] = useState<Sheet>(null);
  const camp = thread?.kind === "camp" ? thread : undefined;
  return (
    <header className="@container/header flex items-center gap-3 border-b-(length:--edge) border-line px-6 pt-3.5 pb-3">
      {/* The way back to the chat list: the hob's page, which opens on its Chats tab. */}
      <Button asChild variant="quiet" size="icon" className="-ms-2 -me-1">
        <Link
          to="/hobs/$hobId"
          params={{ hobId }}
          aria-label={copy.backToChats({ name: hob.name })}
          title={copy.backToChats({ name: hob.name })}
        >
          <BackIcon />
        </Link>
      </Button>
      {/* The tile and the name both open the hob's page; the tile is left out of the tab order. */}
      <Link
        to="/hobs/$hobId"
        params={{ hobId }}
        tabIndex={-1}
        aria-hidden
        className="relative shrink-0 no-underline @max-[340px]/header:hidden"
      >
        {camp === undefined ? <HobSprite hob={hob} size={40} state={state} badge /> : <CampTile hob={hob} />}
      </Link>
      {/* The title keeps its room when the quest button crowds the header, and gives it up in a
          column beside the Quest room, where the buttons need it. */}
      <HeaderTitle
        hob={hob}
        camp={camp}
        doing={doing}
        renaming={camp !== undefined && renaming}
        onDone={() => setRenamingIn(undefined)}
      />
      {/* What the hob reads each turn, and the chapter it is focused on (ADR 037). */}
      {thread && <FocusChip hob={hob} thread={thread} />}
      {/* Beside the open room, whose header is the Quest's, the column keeps its width for the chat. */}
      {threadId && headerEnd === undefined && <ThreadQuestButton hobId={hobId} threadId={threadId} pins={pins} />}
      {thread && <ChatSearchButton open={finding} onToggle={() => onFinding(!finding)} />}
      {/* A camp's brief, records and what is yours (ADR 037). */}
      {camp && <CampSheetButton camp={camp} open={sheet === "camp"} onOpen={() => setSheet("camp")} />}
      <HeaderMenu
        hob={hob}
        thread={thread}
        onRename={() => setRenamingIn(threadId)}
        onSearch={() => onFinding(true)}
        onSheet={setSheet}
      />
      {headerEnd}
      <HeaderSheet sheet={sheet} hob={hob} thread={thread} onClose={() => setSheet(null)} />
    </header>
  );
}

/** A camp's brief, records and what is yours (ADR 037), from the header. */
function CampSheetButton({ camp, open, onOpen }: { camp: Thread; open: boolean; onOpen: () => void }) {
  return (
    <Button
      variant="outline"
      size="xs"
      aria-label={sheetCopy.openFor({ title: camp.title })}
      aria-expanded={open}
      onClick={onOpen}
    >
      {sheetCopy.open}
    </Button>
  );
}

/** The sheet the header opened, if any. */
function HeaderSheet({
  sheet,
  hob,
  thread,
  onClose,
}: {
  sheet: Sheet;
  hob: Agent;
  thread: Thread | undefined;
  onClose: () => void;
}) {
  if (sheet === "make-camp") return <MakeCampSheet hob={hob} onClose={onClose} />;
  if (thread === undefined) return null;
  if (sheet === "start-fresh") return <StartFreshSheet hob={hob} chat={thread} onClose={onClose} />;
  if (sheet === "camp" && thread.kind === "camp") return <CampSheet hob={hob} camp={thread} onClose={onClose} />;
  return null;
}

/** The title column: the camp's title or the hob's name, the line under it, and a camp's goal. */
function HeaderTitle({
  hob,
  camp,
  doing,
  renaming,
  onDone,
}: {
  hob: Agent;
  camp: Thread | undefined;
  doing: string;
  renaming: boolean;
  onDone: () => void;
}) {
  return (
    <div className="flex min-w-[120px] flex-1 flex-col overflow-hidden @max-[340px]/header:min-w-0">
      <ChatTitle thread={camp} title={camp?.title ?? hob.name} renaming={renaming} onDone={onDone} />
      <HeaderLine hob={hob} camp={camp} doing={doing} />
      {camp?.goal != null && (
        <span className="truncate text-meta text-label" title={camp.goal}>
          {headerCopy.goal({ goal: camp.goal })}
        </span>
      )}
    </div>
  );
}

/** Under the title: "Your chat with" the hob in its chat, the hob that leads a camp, then what it does. */
function HeaderLine({ hob, camp, doing }: { hob: Agent; camp: Thread | undefined; doing: string }) {
  return (
    <span className="truncate text-detail text-text-secondary">
      <Link
        to="/hobs/$hobId"
        params={{ hobId: hob.id }}
        title={copy.openHob({ name: hob.name })}
        className="font-semibold text-text no-underline hover:underline"
      >
        {camp === undefined ? headerCopy.chatWith({ name: hob.name }) : hob.name}
      </Link>
      {camp === undefined ? headerCopy.doingLine({ doing }) : copy.leadLine({ doing })}
    </span>
  );
}

/** A camp's tile: the camp mark, with the hob that leads it in its corner. */
function CampTile({ hob }: { hob: Agent }) {
  return (
    <span className="relative inline-flex size-10 items-center justify-center rounded-tile bg-card text-title">
      <span aria-hidden>{headerCopy.glyph}</span>
      <span className="absolute -end-1.5 -bottom-1.5 inline-flex rounded-tile bg-tile border-(length:--edge) border-ground">
        <HobSprite hob={hob} size={20} />
      </span>
    </span>
  );
}

/**
 * The header's ⋯ menu, with the brain picker it opens beside it once the thread exists (A2-02).
 */
function HeaderMenu({
  hob,
  thread,
  onRename,
  onSearch,
  onSheet,
}: {
  hob: Agent;
  thread: Thread | undefined;
  onRename: () => void;
  onSearch: () => void;
  onSheet: (sheet: Sheet) => void;
}) {
  const [picking, setPicking] = useState(false);
  const menu = (
    <ThreadHeaderMenu
      hob={hob}
      thread={thread}
      onRename={onRename}
      onSearch={onSearch}
      onBrain={() => setPicking(true)}
      onMakeCamp={() => onSheet("make-camp")}
      onStartFresh={() => onSheet("start-fresh")}
    />
  );
  if (thread === undefined) return menu;
  return (
    <BrainPicker hob={hob} thread={thread} open={picking} onOpenChange={setPicking}>
      {menu}
    </BrainPicker>
  );
}
