import type { Agent, AgentId, MemberWork } from "@hobbots/domain";
import { cn } from "@hobbots/ui/lib/utils";
import { useQuery } from "@tanstack/react-query";
import { agentsQuery } from "../../api/queries.ts";
import { useHobQuestWork } from "../../api/quest-work.ts";
import { portraitIds, type QuestInProgress, type WorkTone, workTone } from "../../lib/quest-work.ts";
import { HobSprite } from "../hob-sprite.tsx";
import { messages } from "./messages.ts";
import { QuestLink } from "./quest-link.tsx";

const toneText: Record<WorkTone, string> = {
  needs: "text-lantern",
  working: "text-mint",
  waiting: "text-label",
  done: "text-mint",
  problem: "text-rose",
  idle: "text-secondary-text",
};

const toneBar: Record<WorkTone, string> = {
  needs: "bg-lantern",
  working: "bg-mint-deep",
  waiting: "bg-control",
  done: "bg-mint",
  problem: "bg-rose",
  idle: "bg-line-2",
};

const useHobs = () => {
  const agents = useQuery(agentsQuery);
  return new Map((agents.data ?? []).map((hob) => [hob.id, hob]));
};

/**
 * A hob's work on other hobs' Quests, under its row in the hob panel: "On Aldric's quest" and its
 * Task's state, each opening the Quest. It is never one of the hob's threads.
 */
export function HobQuestWork({ hob }: { hob: Agent }) {
  const work = useHobQuestWork(hob.id);
  const hobs = useHobs();
  if (work.length === 0) return null;
  return (
    <ul className="m-0 flex list-none flex-col p-0">
      {work.map((each) => {
        const lead = hobs.get(each.quest.leadId);
        const leadName = lead?.name ?? "";
        const state = messages.state[each.task.state];
        return (
          <li key={each.task.id}>
            <QuestLink
              quest={each.quest}
              threadAgentId={each.threadAgentId}
              label={messages.openQuest({ name: hob.name, lead: leadName, state })}
              className="flex w-full animate-hb-in items-center gap-1.5 py-[3px] ps-[46px] pe-2 text-xs text-secondary-text no-underline hover:bg-hover hover:text-text"
            >
              {lead && <HobSprite hob={lead} size={14} />}
              <span className="min-w-0 flex-1 truncate">{messages.onQuest({ lead: leadName })}</span>
              <span className={cn("whitespace-nowrap", toneText[workTone[each.task.state]])}>{state}</span>
            </QuestLink>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Home's Quests in progress: one entry per Quest with its party's portraits, how far its members
 * got, and each member's line "On Aldric's quest" with its Task's state. Each entry opens the Quest.
 */
export function QuestsInProgress({ quests }: { quests: ReadonlyArray<QuestInProgress> }) {
  const hobs = useHobs();
  if (quests.length === 0)
    return <p className="m-0 text-sm leading-normal text-secondary-text">{messages.home.empty}</p>;
  return (
    <ul className="m-0 flex list-none flex-col gap-3 p-0">
      {quests.map((group) => (
        <li key={group.quest.id}>
          <QuestEntry group={group} hobs={hobs} />
        </li>
      ))}
    </ul>
  );
}

function QuestEntry({ group, hobs }: { group: QuestInProgress; hobs: ReadonlyMap<AgentId, Agent> }) {
  const lead = hobs.get(group.quest.leadId)?.name ?? "";
  const done = group.members.filter((each) => each.task.state === "completed").length;
  const total = group.members.length;
  const portraits = portraitIds(group).flatMap((id) => {
    const hob = hobs.get(id);
    return hob ? [hob] : [];
  });
  return (
    <QuestLink
      quest={group.quest}
      threadAgentId={group.threadAgentId}
      className="flex flex-col gap-1.5 text-text no-underline hover:text-moonlight"
    >
      <span className="flex items-center gap-2 text-sm">
        <span aria-hidden className="flex">
          {portraits.map((hob) => (
            <HobSprite key={hob.id} hob={hob} size={20} className="-me-1" />
          ))}
        </span>
        <span className="min-w-0 flex-1 truncate ps-1.5 font-bold">{group.quest.goal}</span>
        <span className="text-xs whitespace-nowrap text-label">{messages.home.progress({ done, total })}</span>
      </span>
      <span aria-hidden className="flex gap-[3px]">
        {group.members.map((each) => (
          <span key={each.task.id} className={cn("h-1.5 flex-1", toneBar[workTone[each.task.state]])} />
        ))}
      </span>
      {group.members.map((each) => (
        <MemberLine key={each.task.id} work={each} hob={hobs.get(each.task.ownerId)} lead={lead} />
      ))}
    </QuestLink>
  );
}

function MemberLine({ work, hob, lead }: { work: MemberWork; hob: Agent | undefined; lead: string }) {
  return (
    <span className="flex items-center gap-2 text-[13px] leading-snug">
      {hob && <HobSprite hob={hob} size={18} />}
      <span className="w-16 flex-none truncate font-pixel font-semibold text-moonlight">{hob?.name}</span>
      <span className="min-w-0 flex-1 truncate text-secondary-text">{messages.onQuest({ lead })}</span>
      <span className={cn("whitespace-nowrap text-xs", toneText[workTone[work.task.state]])}>
        {messages.state[work.task.state]}
      </span>
    </span>
  );
}
