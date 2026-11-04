import type { Agent } from "@hobbots/domain";
import { cn } from "@hobbots/ui/lib/utils";
import { useQuery } from "@tanstack/react-query";
import { agentsQuery } from "../../api/queries.ts";
import { useHobQuestWork } from "../../api/quest-work.ts";
import { type WorkTone, workTone } from "../../lib/quest-work.ts";
import { HobSprite } from "../hob-sprite/hob-sprite.tsx";
import { messages } from "./messages.ts";
import { QuestLink } from "./quest-link.tsx";

const toneText: Record<WorkTone, string> = {
  needs: "text-lantern",
  working: "text-mint",
  waiting: "text-label",
  done: "text-mint",
  problem: "text-rose",
  idle: "text-text-secondary",
};

const useHobs = () => {
  const agents = useQuery(agentsQuery);
  return new Map((agents.data ?? []).map((hob) => [hob.id, hob]));
};

/**
 * A hob's work on other hobs' Quests, on its card under what it is doing: "On Aldric's quest" and
 * its Task's state, each opening the Quest. It is never one of the hob's threads.
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
              taskId={each.task.id}
              label={messages.openQuest({ name: hob.name, lead: leadName, state })}
              className="flex w-full items-center gap-1.5 rounded-control py-0.5 text-detail text-text-secondary no-underline hover:text-text-strong"
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
