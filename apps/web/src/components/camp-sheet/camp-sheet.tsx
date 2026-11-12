import { type Agent, isNote, type MessageId, type TaskId, type Thread } from "@hobbots/domain";
import { Sheet, SheetCloseButton, SheetContent, SheetHeader, SheetTitle } from "@hobbots/ui/components/sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@hobbots/ui/components/tabs";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { pinsQuery } from "../../api/notes.ts";
import { messagesQuery } from "../../api/queries.ts";
import { artifactsQuery, decisionsQuery } from "../../api/records.ts";
import { messages as campCopy } from "../camps/messages.ts";
import type { Pins } from "../quest/use-work.ts";
import { QuestPane } from "../quest-sheet/quest-pane.tsx";
import { ArtifactsTab } from "./artifacts-tab.tsx";
import { DecisionsTab } from "./decisions-tab.tsx";
import { messages } from "./messages.ts";
import { MineTab } from "./mine-tab.tsx";
import { OverviewTab } from "./overview-tab.tsx";

const TABS = ["overview", "decisions", "artifacts", "mine"] as const;
type CampTab = (typeof TABS)[number];
const isCampTab = (value: string): value is CampTab => (TABS as ReadonlyArray<string>).includes(value);

/** How many rows each tab holds, beside its name, once read. */
const useTabCounts = (thread: Thread): Partial<Record<CampTab, number>> => {
  const decisions = useQuery(decisionsQuery(thread.id)).data;
  const artifacts = useQuery(artifactsQuery(thread.id)).data;
  const pins = useQuery(pinsQuery(thread.id)).data;
  const notes = useQuery({ ...messagesQuery(thread.id), select: (all) => all.filter(isNote).length }).data;
  return {
    ...(decisions !== undefined && { decisions: decisions.length }),
    ...(artifacts !== undefined && { artifacts: artifacts.length }),
    ...(pins !== undefined && notes !== undefined && { mine: pins.length + notes }),
  };
};

/**
 * A camp's sheet beside its chat (ADR 037): Overview with the brief and the camp's quests, Decisions,
 * Artifacts at their latest version, and Mine, your pins and notes to self. Every list is the hub's,
 * kept live by its events. Showing where something happened closes the sheet and scrolls the chat to
 * it. A quest opens in the sheet in their place, with Back to the camp.
 */
export function CampSheet({
  hob,
  camp,
  quest,
  pins,
  onOpenQuest,
  onBack,
  onClose,
}: {
  hob: Agent;
  camp: Thread;
  pins: Pins;
  /** The quest the sheet shows, by one of its Tasks, in place of the camp's tabs. */
  quest: TaskId | undefined;
  onOpenQuest: (taskId: TaskId) => void;
  /** Back from the quest to the camp's tabs. */
  onBack: () => void;
  onClose: () => void;
}) {
  return (
    <Sheet open onOpenChange={(open) => !open && onClose()}>
      <SheetContent aria-describedby={undefined}>
        {quest === undefined ? (
          <CampTabs hob={hob} camp={camp} onOpenQuest={onOpenQuest} onClose={onClose} />
        ) : (
          <QuestPane
            hobId={hob.id}
            threadId={camp.id}
            taskId={quest}
            back={{ title: camp.title, go: onBack }}
            pins={pins}
          />
        )}
      </SheetContent>
    </Sheet>
  );
}

function CampTabs({
  hob,
  camp,
  onOpenQuest,
  onClose,
}: {
  hob: Agent;
  camp: Thread;
  onOpenQuest: (taskId: TaskId) => void;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<CampTab>("overview");
  const counts = useTabCounts(camp);
  const navigate = useNavigate();
  const jump = (messageId: MessageId) => {
    onClose();
    void navigate({
      to: "/hobs/$hobId/threads/$threadId",
      params: { hobId: hob.id, threadId: camp.id },
      search: { message: messageId },
    });
  };
  return (
    <>
      <SheetHeader>
        <span className="flex items-center gap-1.5 text-meta font-semibold text-star">
          <span aria-hidden>{campCopy.header.glyph}</span>
          {messages.eyebrow({ name: hob.name })}
        </span>
        <SheetCloseButton label={messages.close} />
      </SheetHeader>
      <SheetTitle clamped>{camp.title}</SheetTitle>
      <Tabs value={tab} onValueChange={(value) => isCampTab(value) && setTab(value)}>
        {/* The tabs run to the sheet's edges and stay compact, and their counts stay short, so all four fit its width. */}
        <TabsList variant="tight" className="-mx-[18px] mb-3.5">
          {TABS.map((each) => (
            <TabsTrigger key={each} value={each} variant="tight">
              <span className="min-w-0 truncate">{messages.tabs[each]}</span>
              {counts[each] !== undefined && (
                <span className="shrink-0 rounded-tag bg-line px-1.5 text-meta font-semibold text-text-secondary">
                  {messages.count({ count: counts[each] })}
                </span>
              )}
            </TabsTrigger>
          ))}
        </TabsList>
        <TabsContent value="overview">
          <OverviewTab thread={camp} hobName={hob.name} onOpenQuest={onOpenQuest} />
        </TabsContent>
        <TabsContent value="decisions">
          <DecisionsTab thread={camp} hobName={hob.name} />
        </TabsContent>
        <TabsContent value="artifacts">
          <ArtifactsTab thread={camp} hobName={hob.name} onJump={jump} />
        </TabsContent>
        <TabsContent value="mine">
          <MineTab thread={camp} onJump={jump} />
        </TabsContent>
      </Tabs>
    </>
  );
}
