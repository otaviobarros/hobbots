import { MOON, MOON_PALETTE } from "@hobbots/art/moon";
import type { Agent, AgentId, TaskId, ThreadId } from "@hobbots/domain";
import { Badge } from "@hobbots/ui/components/badge";
import { PixelArt } from "@hobbots/ui/components/pixel-art";
import { cn } from "@hobbots/ui/lib/utils";
import { useQuery } from "@tanstack/react-query";
import { useId, useState } from "react";
import { useActivity } from "../api/activity.ts";
import { agentsQuery } from "../api/queries.ts";
import { readStored, writeStored } from "../lib/storage.ts";
import { HobSprite } from "./hob-sprite.tsx";
import { QuestTab } from "./quest/quest-tab.tsx";
import type { Pins } from "./quest/use-work.ts";
import { Stars } from "./scene.tsx";

const TABS = ["Quest", "Inbox", "Workshop"] as const;
type Tab = (typeof TABS)[number];

/** Right panel of the chat workspace: Quest, Inbox and the live Workshop scene. */
export function SidePanel({
  hobId,
  threadId,
  taskId,
  pins,
}: {
  hobId: AgentId;
  threadId?: ThreadId | undefined;
  /** The Task open in the drawer, marked in the Quest tab. */
  taskId?: TaskId | undefined;
  pins: Pins;
}) {
  const [tab, setTab] = useState<Tab>(() => readStored<Tab>("layout.panelTab", "Quest"));
  const id = useId();
  const pick = (next: Tab) => {
    setTab(next);
    writeStored("layout.panelTab", next);
  };

  return (
    <aside
      aria-label="Quest and inbox"
      className="flex min-h-0 w-[340px] flex-none flex-col border-l-4 border-line bg-panel"
    >
      <div role="tablist" aria-label="Panel" className="flex border-b-4 border-line">
        {TABS.map((name) => (
          <button
            key={name}
            type="button"
            role="tab"
            id={`${id}-${name}`}
            aria-selected={tab === name}
            aria-controls={`${id}-panel`}
            onClick={() => pick(name)}
            className={cn(
              "flex-1 cursor-pointer border-0 px-1.5 py-[11px] text-sm font-bold",
              tab === name ? "bg-line text-moonlight" : "bg-transparent text-label hover:bg-hover hover:text-text",
            )}
          >
            {name}
          </button>
        ))}
      </div>
      <div
        role="tabpanel"
        id={`${id}-panel`}
        aria-labelledby={`${id}-${tab}`}
        className="min-h-0 flex-1 overflow-y-auto"
      >
        {tab === "Quest" && <QuestTab key={threadId} hobId={hobId} threadId={threadId} taskId={taskId} pins={pins} />}
        {tab === "Inbox" && (
          <Empty title="Nothing here yet">
            Questions, approvals, problems and results for this thread land here, each with its delivery state.
          </Empty>
        )}
        {tab === "Workshop" && <Workshop hobId={hobId} threadId={threadId} />}
      </div>
    </aside>
  );
}

function Empty({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex animate-hb-in flex-col gap-2 px-[18px] py-[22px] leading-normal text-secondary-text">
      <span className="font-pixel text-lg text-moonlight">{title}</span>
      <span>{children}</span>
    </div>
  );
}

function Workshop({ hobId, threadId }: { hobId: string; threadId?: ThreadId | undefined }) {
  const hob = useQuery({ ...agentsQuery, select: (agents) => agents.find((a) => a.id === hobId) });
  const activity = useActivity();
  const current = hob.data;
  if (!current) return null;
  const now = threadId ? activity[threadId] : undefined;

  return (
    <div className="flex flex-col">
      <div className="relative h-[230px] overflow-hidden border-b-4 border-line bg-ground">
        <Stars count={12} height={150} />
        <PixelArt rows={MOON} palette={MOON_PALETTE} size={36} className="absolute top-[18px] right-6" />
        <Badge variant={now ? "live" : "muted"} className="absolute top-3 left-3">
          {now ? "● Live" : "Quiet"}
        </Badge>
        <div aria-hidden className="absolute inset-x-0 bottom-0 h-[50px] border-t-[5px] border-line-2 bg-line" />
        <div className="absolute bottom-[30px] left-[60px] flex items-end gap-2">
          <HobSprite hob={current} size={64} state={now ? "working" : "idle"} />
          <div aria-hidden className="h-[42px] w-[84px] border-t-8 border-[#8a6240] bg-[#6b4a2f]" />
        </div>
        <span className="absolute top-[54px] left-[110px] max-w-[200px] bg-text px-2.5 py-1.5 text-[13px] text-ground">
          {doing(current, now)}
        </span>
      </div>
      <p className="m-0 px-4 py-3.5 text-sm leading-normal text-secondary-text">
        The Workshop shows what {current.name} is doing right now. Terminal output, files and code changes open in the
        Workbench, which arrives with the MVP.
      </p>
    </div>
  );
}

const doing = (hob: Agent, now: "thinking" | "working" | undefined) =>
  now === "working" ? "Writing a reply…" : now === "thinking" ? "Thinking it over…" : `${hob.name} is resting.`;
