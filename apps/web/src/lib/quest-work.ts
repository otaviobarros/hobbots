import type { AgentId, MemberWork, Quest, TaskState } from "@hobbots/domain";

/** One Quest on Home: its lead, and its party's work in the order they joined. */
export interface QuestInProgress {
  readonly quest: Quest;
  readonly members: ReadonlyArray<MemberWork>;
}

/**
 * Groups members' work by Quest, oldest Quest first. Work on a nested Quest stays with that Quest,
 * whose lead is the member that brought the hob in.
 */
export const questsInProgress = (work: ReadonlyArray<MemberWork>): ReadonlyArray<QuestInProgress> => {
  const byQuest = new Map<string, { quest: Quest; members: Array<MemberWork> }>();
  for (const each of work) {
    const group = byQuest.get(each.quest.id) ?? { quest: each.quest, members: [] };
    group.members.push(each);
    byQuest.set(each.quest.id, group);
  }
  return [...byQuest.values()]
    .map(({ quest, members }) => ({
      quest,
      members: members.toSorted((a, b) => a.task.createdAt.localeCompare(b.task.createdAt)),
    }))
    .sort((a, b) => a.quest.createdAt.localeCompare(b.quest.createdAt) || a.quest.id.localeCompare(b.quest.id));
};

/** How a member's Task state reads at a glance: the tone its label and progress segment take. */
export type WorkTone = "needs" | "working" | "waiting" | "done" | "problem" | "idle";

export const workTone: Record<TaskState, WorkTone> = {
  queued: "idle",
  active: "working",
  waiting: "waiting",
  blocked: "needs",
  cancelling: "idle",
  completed: "done",
  failed: "problem",
  cancelled: "idle",
};

/** The hobs on a Quest's card: its lead first, then its party in the order they joined. */
export const portraitIds = (group: QuestInProgress): ReadonlyArray<AgentId> => [
  group.quest.leadId,
  ...new Set(group.members.map((each) => each.task.ownerId)),
];
