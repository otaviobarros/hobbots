import type { Agent, ChannelId, MessageId, WorkQuest } from "@hobbots/domain";
import { cn } from "@hobbots/ui/lib/utils";
import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { workQuestsQuery } from "../../api/records.ts";
import { HobTile } from "../hob-sprite/hob-sprite.tsx";
import { messages } from "./messages.ts";

/** The eyebrow's color and dot for each state: mint while it runs, lantern while it needs you. */
const TONE: Readonly<Record<WorkQuest["state"], { readonly text: string; readonly dot: string }>> = {
  active: { text: "text-mint", dot: "bg-mint" },
  waiting: { text: "text-lantern", dot: "bg-lantern animate-hb-blink" },
  done: { text: "text-lantern", dot: "bg-lantern" },
  stopped: { text: "text-label", dot: "bg-label" },
};

/**
 * A Quest's card (ADR 041): one living card at the reply whose turn started it, which updates in
 * place as the Quest changes. It shows the state, the title, the goal, the "Done when" lines and who
 * runs it, and once done, the result and what the work made.
 */
export function WorkQuestCard({ quest, owner }: { quest: WorkQuest; owner: Agent | undefined }) {
  const tone = TONE[quest.state];
  const ready = quest.state === "done";
  return (
    <section
      aria-label={messages.label({ title: quest.title })}
      className={cn(
        "ms-10 flex w-[calc(100%-2.5rem)] max-w-work-max animate-hb-in flex-col overflow-hidden rounded-card bg-card shadow-[inset_0_0_0_1px_var(--color-line-2)]",
        (quest.state === "waiting" || ready) && "shadow-[inset_0_0_0_var(--edge)_var(--color-lantern)]",
      )}
    >
      <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1 px-4 pt-3.5 pb-3">
        <span className={cn("flex items-center gap-2 text-meta font-bold tracking-[.06em] uppercase", tone.text)}>
          <span aria-hidden className={cn("size-1.5 rounded-dot", tone.dot)} />
          {messages.eyebrow[quest.state]}
        </span>
        {owner !== undefined && (
          <span className="row-span-3 flex items-start" title={messages.owner({ hob: owner.name })}>
            <HobTile hob={owner} tile="sm" state={quest.state === "active" ? "working" : "idle"} />
          </span>
        )}
        <span className="font-heading text-title font-(--heading-weight) text-text-strong">{quest.title}</span>
        <span className="text-detail text-text-secondary">{quest.goal}</span>
      </div>
      <div className="flex flex-col gap-3 px-4 pb-3.5">
        <Part title={messages.doneWhen}>
          <ul className="flex flex-col gap-1">
            {quest.doneWhen.map((line) => (
              <li key={line} className="flex items-start gap-2 text-detail text-text">
                <span
                  aria-hidden
                  className={cn(
                    "mt-1 size-3 shrink-0 rounded-dot border-2",
                    ready ? "border-mint bg-mint" : "border-line-2",
                  )}
                />
                {line}
              </li>
            ))}
          </ul>
        </Part>
        {quest.result !== null && (
          <Part title={messages.result}>
            <p className="text-detail text-text">{quest.result}</p>
          </Part>
        )}
        {quest.made.length > 0 && (
          <Part title={messages.made}>
            <ul className="flex flex-wrap gap-1.5">
              {quest.made.map((thing) => (
                <li key={thing} className="rounded-tag bg-deep px-2 py-0.5 text-meta text-text-strong">
                  {thing}
                </li>
              ))}
            </ul>
          </Part>
        )}
      </div>
      <div className="flex items-center gap-3 border-t border-line bg-[color-mix(in_srgb,var(--color-deep)_40%,transparent)] px-4 py-2.5 text-meta text-label">
        {owner !== undefined && <span>{messages.owner({ hob: owner.name })}</span>}
        <span>{messages.started({ time: quest.createdAt })}</span>
        {quest.expectedBy !== null && <span>{messages.expectedBy({ day: quest.expectedBy })}</span>}
      </div>
    </section>
  );
}

function Part({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-meta font-semibold text-label">{title}</span>
      {children}
    </div>
  );
}

/** The one line a finished Quest leaves at the reply that finished it: "Aldric finished Winter market page · PR #12". */
function FinishedLine({ quest, owner }: { quest: WorkQuest; owner: Agent | undefined }) {
  return (
    <p role="status" className="ms-10 animate-hb-in text-detail text-text-secondary">
      {[messages.finished({ hob: owner?.name ?? "", title: quest.title }), ...quest.made.slice(0, 1)].join(
        messages.dot,
      )}
    </p>
  );
}

/**
 * The chat's Quests (ADR 041), placed in the transcript: each card under the reply that started it,
 * and the line a finished one leaves under the reply that finished it, when that is another reply.
 */
export const useWorkQuestCards = (channelId: ChannelId | undefined, hobs: ReadonlyArray<Agent> | undefined) => {
  const quests = useQuery({
    ...workQuestsQuery(channelId ?? ("" as ChannelId)),
    enabled: channelId !== undefined,
  }).data;
  const ownerOf = (quest: WorkQuest) => hobs?.find((hob) => hob.id === quest.ownerHobId);
  return {
    after: (messageId: MessageId): ReactNode =>
      quests?.map((quest) =>
        quest.startedFrom === messageId ? (
          <WorkQuestCard key={quest.id} quest={quest} owner={ownerOf(quest)} />
        ) : quest.finishedFrom === messageId ? (
          <FinishedLine key={quest.id} quest={quest} owner={ownerOf(quest)} />
        ) : null,
      ),
  };
};
