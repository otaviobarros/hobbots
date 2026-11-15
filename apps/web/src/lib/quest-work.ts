import type { AgentId, MemberWork, Quest } from "@hobbots/domain";

/** One Quest on Home: its lead, and its party's work in the order they joined. */
export interface QuestInProgress {
  readonly quest: Quest;
  /** The hob whose channel the Quest is followed in. */
  readonly channelAgentId: AgentId | null;
  readonly members: ReadonlyArray<MemberWork>;
}

/**
 * Groups members' work by Quest, oldest Quest first. Work on a nested Quest stays with that Quest,
 * whose lead is the member that brought the hob in.
 */
export const questsInProgress = (work: ReadonlyArray<MemberWork>): ReadonlyArray<QuestInProgress> => {
  const byQuest = new Map<string, { quest: Quest; channelAgentId: AgentId | null; members: Array<MemberWork> }>();
  for (const each of work) {
    const group = byQuest.get(each.quest.id) ?? { quest: each.quest, channelAgentId: each.channelAgentId, members: [] };
    group.members.push(each);
    byQuest.set(each.quest.id, group);
  }
  return [...byQuest.values()]
    .map(({ quest, channelAgentId, members }) => ({
      quest,
      channelAgentId,
      members: members.toSorted((a, b) => a.task.createdAt.localeCompare(b.task.createdAt)),
    }))
    .sort((a, b) => a.quest.createdAt.localeCompare(b.quest.createdAt) || a.quest.id.localeCompare(b.quest.id));
};
