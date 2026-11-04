import { AgentId, Delegation, Quest, QuestId, TaskId } from "@hobbots/domain";
import { describe, expect, it } from "vitest";
import {
  ADA,
  ALDRIC,
  BUILD,
  blackFriday,
  CAMPAIGN,
  COPY,
  delegation,
  QUILL,
  quest,
  task,
  tree,
} from "../../test/quests.ts";
import { laneOf, laneTask, litTask, roomLanes } from "./room-model.ts";
import { hasUnread, nextSeen, parseFold } from "./use-chat-fold.ts";

const ROOK = AgentId.make("rook");
const RESEARCH = TaskId.make("research");
const POLISH = TaskId.make("polish");
const STEP = TaskId.make("step");

/** Ada leads a Quest of her own under Aldric's, and Rook researches for her. */
const nested = () => {
  const base = blackFriday();
  const inner = QuestId.make("quest-build");
  return tree({
    ...base,
    tasks: [...base.tasks, task(RESEARCH, { ownerId: ROOK, parentId: BUILD, brief: "Research keywords", second: 4 })],
    quests: [...base.quests, new Quest({ ...quest(), id: inner, taskId: BUILD, leadId: ADA, depth: 2 })],
    delegations: [
      ...base.delegations,
      new Delegation({
        ...delegation(ROOK, RESEARCH, "Research keywords"),
        questId: inner,
        leadId: ADA,
        parentTaskId: BUILD,
      }),
    ],
  });
};

describe("roomLanes", () => {
  it("gives the lead and each member a lane, in the order they joined", () => {
    const lanes = roomLanes(blackFriday());
    expect(lanes.map((lane) => [lane.ownerId, lane.lead, lane.rows.map((row) => row.task.id)])).toEqual([
      [ALDRIC, true, [CAMPAIGN]],
      [QUILL, false, [COPY]],
      [ADA, false, [BUILD]],
    ]);
  });

  it("gives a Task alone one lane", () => {
    const alone = tree({ tasks: [task(CAMPAIGN, { brief: "Plan a launch" })] });
    expect(roomLanes(alone).map((lane) => lane.ownerId)).toEqual([ALDRIC]);
  });

  it("names the party a member leads on a Quest of its own", () => {
    const lanes = roomLanes(nested());
    expect(lanes.map((lane) => [lane.ownerId, lane.leads])).toEqual([
      [ALDRIC, []],
      [QUILL, []],
      [ADA, [ROOK]],
      [ROOK, []],
    ]);
  });

  it("keeps a hob's steps and second Task in its one lane", () => {
    const base = blackFriday();
    const more = tree({
      ...base,
      tasks: [
        ...base.tasks,
        task(STEP, { ownerId: QUILL, parentId: COPY, brief: "Check the tone", second: 4 }),
        task(POLISH, { ownerId: QUILL, parentId: CAMPAIGN, brief: "Polish the copy", second: 5 }),
      ],
    });
    const quill = roomLanes(more).find((lane) => lane.ownerId === QUILL);
    expect(quill?.rows.map((row) => row.task.id)).toEqual([COPY, STEP, POLISH]);
    expect(roomLanes(more)).toHaveLength(3);
  });
});

describe("the lit lane", () => {
  it("lights the lane the address names, else the Task a link named, else none", () => {
    const quest = blackFriday();
    const [top, copy] = quest.tasks;
    if (top === undefined || copy === undefined) throw new Error("The tree has its Tasks");
    expect(litTask(quest, top, BUILD)).toBe(BUILD);
    expect(litTask(quest, copy, undefined)).toBe(COPY);
    expect(litTask(quest, top, undefined)).toBeUndefined();
    // A lane from another Quest lights nothing here.
    expect(litTask(quest, top, TaskId.make("elsewhere"))).toBeUndefined();
  });

  it("finds the lane that holds a Task, and the Task each lane stands for", () => {
    const lanes = roomLanes(nested());
    expect(laneOf(lanes, RESEARCH)?.ownerId).toBe(ROOK);
    expect(laneOf(lanes, undefined)).toBeUndefined();
    const ada = laneOf(lanes, BUILD);
    if (ada === undefined) throw new Error("Ada has a lane");
    expect(laneTask(ada).id).toBe(BUILD);
  });
});

describe("parseFold", () => {
  it("reads the fold this device kept, and the open column for anything else", () => {
    expect(parseFold({ v: 1, folded: true })).toBe(true);
    expect(parseFold({ v: 1, folded: false })).toBe(false);
    expect(parseFold(true)).toBe(false);
    expect(parseFold({ v: 2, folded: true })).toBe(false);
    expect(parseFold(null)).toBe(false);
  });
});

describe("the folded chat's unread mark", () => {
  it("marks a reply that came while folded, and clears once the chat is back in view", () => {
    const read = nextSeen(undefined, "a", 10, false);
    expect(hasUnread(nextSeen(read, "a", 11, true), "a", 11)).toBe(true);
    const back = nextSeen(nextSeen(read, "a", 11, true), "a", 11, false);
    expect(hasUnread(back, "a", 11)).toBe(false);
  });

  it("starts another thread from its own count, so its first new reply is marked", () => {
    const longA = nextSeen(undefined, "a", 10, false);
    const openB = nextSeen(longA, "b", 2, true);
    expect(openB).toEqual({ thread: "b", count: 2 });
    expect(hasUnread(openB, "b", 2)).toBe(false);
    expect(hasUnread(nextSeen(openB, "b", 3, true), "b", 3)).toBe(true);
    // A thread longer than the last one's count is not marked just for being longer.
    expect(hasUnread(nextSeen(openB, "c", 40, true), "c", 40)).toBe(false);
  });
});
