import {
  type AgentId,
  isTerminalTask,
  type MemberWork,
  openChannelTask,
  type QuestSummary,
  type TaskId,
  type TaskTree,
  type Channel,
  type ChannelId,
} from "@hobbots/domain";
import type { ActivityMap } from "../../api/hub-status.ts";
import { groupOf } from "../../lib/crew.ts";
import type { HobState } from "../../lib/hob-state.ts";
import { summaryProgress } from "../../lib/led-quests.ts";
import type { QuestInProgress } from "../../lib/quest-work.ts";
import { filterCounts, filterOf, type HobFilter } from "../hobs-page/hobs-page-model.ts";
import { messages } from "./messages.ts";

/**
 * Home's summary line: how many hobs, who needs you, then who is working, in the crew's order.
 * "4 hobs. Ada and Pip need you. Aldric is working."
 */
export const homeSummary = (
  crew: ReadonlyArray<{ readonly hob: { readonly name: string }; readonly state: HobState }>,
): string => {
  if (crew.length === 0) return messages.summary.none;
  const names = (group: "needs-you" | "working") =>
    crew.filter((each) => groupOf(each.state) === group).map((each) => each.hob.name);
  const working = names("working");
  return [
    messages.summary.count({ count: crew.length }),
    messages.summary.needs({ names: names("needs-you") }),
    ...(working.length === 0 ? [] : [messages.summary.working({ names: working })]),
  ].join(" ");
};

/**
 * The chat a hob's peek opens: the one it is replying in, else the one it used last. Null when the
 * hob has no chats yet, so the peek starts a new one.
 */
export const peekChannel = <T extends Pick<Channel, "id" | "updatedAt">>(
  channels: ReadonlyArray<T>,
  activity: ActivityMap,
): T | null =>
  channels.find((channel) => activity[channel.id] !== undefined) ??
  channels.toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0] ??
  null;

/** Where the peek's Open Workbench goes: a Task and the chat whose Workbench shows it. */
export interface BenchTarget {
  readonly hobId: AgentId;
  readonly channelId: ChannelId;
  readonly taskId: TaskId;
}

/**
 * The Workbench a hob's peek opens: the Task its chat turns work on in `channelId`, else the open
 * Task it does on a Quest, shown in the Quest's own channel. Null when the hob works on no Task.
 */
export const peekBench = (
  hobId: AgentId,
  channelId: ChannelId | null,
  trees: ReadonlyArray<TaskTree>,
  work: ReadonlyArray<MemberWork>,
): BenchTarget | null => {
  const own = channelId === null ? undefined : openChannelTask(trees, hobId);
  if (own !== undefined && channelId !== null) return { hobId, channelId, taskId: own.top.id };
  const member = work.findLast((each) => !isTerminalTask(each.task.state));
  if (member?.channelAgentId != null && member.quest.channelId !== null) {
    return { hobId: member.channelAgentId, channelId: member.quest.channelId, taskId: member.task.id };
  }
  return null;
};

/**
 * The chips over the scene: All, then each family with hobs in it, with its count. The families
 * are the ones Your hobs filters by, so a chip and its page agree.
 */
export const sceneChips = (
  states: ReadonlyArray<HobState>,
): ReadonlyArray<{ readonly value: HobFilter; readonly count: number }> => {
  const counts = filterCounts(states.map((state) => ({ state })));
  return (["all", "needs", "working", "resting"] as const)
    .map((value) => ({ value, count: counts[value] }))
    .filter(({ value, count }) => value === "all" || count > 0);
};

/** Whether a hob in `state` stays lit under `filter`. */
export const inFilter = (state: HobState, filter: HobFilter): boolean => filter === "all" || filterOf(state) === filter;

/** The filter in force: a picked chip whose family has emptied falls back to All. */
export const activeFilter = (picked: HobFilter, chips: ReturnType<typeof sceneChips>): HobFilter =>
  chips.some((chip) => chip.value === picked) ? picked : "all";

/** One row of Pick up where you left off: a chat, or a Quest in progress. */
export type PickUpRow<H, T> =
  | { readonly kind: "channel"; readonly hob: H; readonly channel: T; readonly at: string }
  | { readonly kind: "quest"; readonly group: QuestInProgress; readonly at: string };

/** How many rows Pick up where you left off shows. */
const PICK_UP_LIMIT = 5;

/** When a Quest last moved: its newest member Task, or when it started. */
const questMoved = (group: QuestInProgress): string =>
  [group.quest.createdAt, ...group.members.map((each) => each.task.updatedAt)].toSorted().at(-1) ??
  group.quest.createdAt;

/**
 * Recent chats and Quests in progress in one list, the most recently active first. `chats` are the
 * open channels, so a Quest followed in a channel that is not among them, as in an archived camp, is
 * left out until the channel opens again; a Quest with no channel shows. A chat that follows a Quest
 * shows once, as that Quest.
 */
export const pickUpRows = <H, T extends Pick<Channel, "id" | "updatedAt">>(
  chats: ReadonlyArray<{ readonly hob: H; readonly channel: T }>,
  quests: ReadonlyArray<QuestInProgress>,
): ReadonlyArray<PickUpRow<H, T>> => {
  const open = new Set(chats.map(({ channel }) => channel.id));
  const shown = quests.filter(({ quest }) => quest.channelId === null || open.has(quest.channelId));
  const questChannels = new Set(shown.flatMap((group) => (group.quest.channelId === null ? [] : [group.quest.channelId])));
  const rows: Array<PickUpRow<H, T>> = [
    ...chats
      .filter(({ channel }) => !questChannels.has(channel.id))
      .map(({ hob, channel }) => ({ kind: "channel" as const, hob, channel, at: channel.updatedAt })),
    ...shown.map((group) => ({ kind: "quest" as const, group, at: questMoved(group) })),
  ];
  return rows.toSorted((a, b) => b.at.localeCompare(a.at)).slice(0, PICK_UP_LIMIT);
};

/**
 * How far a Quest got and how many things wait on you, from the summary the hub published (ADR 037);
 * nothing before it is read.
 */
export const questProgress = (summary: QuestSummary | undefined) =>
  summary === undefined ? { done: 0, total: 0, needs: 0 } : { ...summaryProgress(summary), needs: summary.needsYou };
