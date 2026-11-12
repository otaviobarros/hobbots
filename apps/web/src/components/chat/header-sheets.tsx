import { type Agent, type AgentId, TaskId, type Thread, type ThreadId } from "@hobbots/domain";
import { Button } from "@hobbots/ui/components/button";
import { SheetContent, Sheet as SheetRoot } from "@hobbots/ui/components/sheet";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { CampSheet } from "../camp-sheet/camp-sheet.tsx";
import { messages as sheetCopy } from "../camp-sheet/messages.ts";
import { MakeCampSheet } from "../camps/make-camp-sheet.tsx";
import { StartFreshSheet } from "../camps/start-fresh-sheet.tsx";
import type { Pins } from "../quest/use-work.ts";
import { QuestPane } from "../quest-sheet/quest-pane.tsx";
import { useOpenQuest } from "../quest-sheet/quest-search.ts";

/** Which sheet the header opened: from its menu, or a camp's own sheet. */
export type Sheet = "make-camp" | "start-fresh" | "camp" | null;

/**
 * The quest the address opens in the thread's sheet (ADR 037), and how to leave it: none while its
 * Workbench is open beside the chat instead.
 */
export const useQuestInSheet = (hobId: AgentId, threadId: ThreadId | undefined) => {
  const search = useSearch({ strict: false });
  const navigate = useNavigate();
  const quest = search.tab === undefined && search.quest !== undefined ? TaskId.make(search.quest) : undefined;
  return {
    quest: threadId === undefined ? undefined : quest,
    clear: () =>
      threadId !== undefined &&
      void navigate({ to: "/hobs/$hobId/threads/$threadId", params: { hobId, threadId }, search: {} }),
  };
};

type QuestInSheet = ReturnType<typeof useQuestInSheet>;

/**
 * The sheets a chat's header opens on the right (ADR 037): a camp's own sheet, which also shows a
 * quest of the camp with Back to the camp, or in a chat a quest of its own in a sheet with no Back.
 */
export function QuestSheets({
  hob,
  threadId,
  camp,
  campOpen,
  onCamp,
  inSheet,
  pins,
}: {
  hob: Agent;
  threadId: ThreadId;
  pins: Pins;
  camp: Thread | undefined;
  /** Whether the camp's own sheet is open on its tabs. */
  campOpen: boolean;
  onCamp: (open: boolean) => void;
  inSheet: QuestInSheet;
}) {
  const openQuest = useOpenQuest(hob.id, threadId);
  if (camp !== undefined) {
    if (!campOpen && inSheet.quest === undefined) return null;
    return (
      <CampSheet
        hob={hob}
        camp={camp}
        quest={inSheet.quest}
        pins={pins}
        // The quest's pane follows the address alone, so showing its work beside the chat leaves no
        // camp overview open over the Workbench.
        onOpenQuest={(taskId) => {
          onCamp(false);
          openQuest(taskId);
        }}
        onBack={() => {
          onCamp(true);
          inSheet.clear();
        }}
        onClose={() => {
          onCamp(false);
          if (inSheet.quest !== undefined) inSheet.clear();
        }}
      />
    );
  }
  if (inSheet.quest === undefined) return null;
  return (
    <SheetRoot open onOpenChange={(open) => !open && inSheet.clear()}>
      <SheetContent aria-describedby={undefined}>
        <QuestPane hobId={hob.id} threadId={threadId} taskId={inSheet.quest} back={null} pins={pins} />
      </SheetContent>
    </SheetRoot>
  );
}

/** A camp's brief, records and what is yours (ADR 037), from the header. */
export function CampSheetButton({ camp, open, onOpen }: { camp: Thread; open: boolean; onOpen: () => void }) {
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
export function HeaderSheet({
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
  return null;
}
