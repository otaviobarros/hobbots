import { AgentId, type TaskTree, ThreadId } from "@hobbots/domain";
import { describe, expect, it } from "vitest";
import { memberWork, quest } from "../../test/member-work.ts";
import { activeFilter, inFilter, peekBench, peekThread, pickUpRows, questProgress, sceneChips } from "./home-model.ts";

const older = { id: ThreadId.make("t-old"), updatedAt: "2026-11-01T08:00:00.000Z" };
const newer = { id: ThreadId.make("t-new"), updatedAt: "2026-11-02T08:00:00.000Z" };

describe("peekThread", () => {
  it("opens the chat the hob is replying in, else the one it used last", () => {
    expect(peekThread([newer, older], { [older.id]: "thinking" })).toBe(older);
    expect(peekThread([older, newer], {})).toBe(newer);
    expect(peekThread([], {})).toBeNull();
  });
});

describe("peekBench", () => {
  const ada = AgentId.make("ada");
  const launch = quest("q1", "aldric");
  // Only the first Task of a tree is read: the request asked of the hob in that thread.
  const treeOf = (work: ReturnType<typeof memberWork>) => ({ tasks: [work.task] }) as unknown as TaskTree;

  it("opens the Task the hob's chat works on", () => {
    const own = memberWork("own", "ada", launch, "active");
    expect(peekBench(ada, newer.id, [treeOf(own)], [])).toEqual({
      hobId: ada,
      threadId: newer.id,
      taskId: own.task.id,
    });
  });

  it("else opens the hob's open Quest work in the Quest's thread", () => {
    const done = memberWork("done", "ada", launch, "completed");
    const build = memberWork("build", "ada", launch, "active");
    expect(peekBench(ada, newer.id, [treeOf(done)], [build, done])).toEqual({
      hobId: AgentId.make("aldric"),
      threadId: launch.threadId,
      taskId: build.task.id,
    });
  });

  it("has no Workbench for a hob with no open Task", () => {
    const done = memberWork("done", "ada", launch, "completed");
    expect(peekBench(ada, null, [], [done])).toBeNull();
  });
});

describe("sceneChips", () => {
  it("counts every hob under All and each family with hobs in it", () => {
    expect(sceneChips(["needs-you", "waiting", "thinking", "idle", "paused", "failed"])).toEqual([
      { value: "all", count: 6 },
      { value: "needs", count: 3 },
      { value: "working", count: 1 },
      { value: "resting", count: 2 },
    ]);
    expect(sceneChips(["idle"])).toEqual([
      { value: "all", count: 1 },
      { value: "resting", count: 1 },
    ]);
  });

  it("falls back to All once the picked family empties", () => {
    const chips = sceneChips(["idle"]);
    expect(activeFilter("resting", chips)).toBe("resting");
    expect(activeFilter("working", chips)).toBe("all");
  });
});

describe("inFilter", () => {
  it("keeps a hob lit under All and under its own family only", () => {
    expect(inFilter("failed", "all")).toBe(true);
    expect(inFilter("failed", "needs")).toBe(true);
    expect(inFilter("failed", "resting")).toBe(false);
    expect(inFilter("waiting", "needs")).toBe(true);
    expect(inFilter("paused", "resting")).toBe(true);
    expect(inFilter("thinking", "resting")).toBe(false);
  });
});

describe("pickUpRows", () => {
  const launch = quest("q1", "aldric", 0);
  const group = (updated: number) => {
    const work = memberWork("copy", "quill", launch, "blocked", updated);
    return { quest: launch, threadAgentId: launch.leadId, members: [work] };
  };
  const chat = (id: string, day: number) => ({
    hob: "aldric",
    thread: { id: ThreadId.make(id), updatedAt: `2026-11-0${day}T08:00:00.000Z` },
  });

  it("mixes chats and Quests, the most recently active first", () => {
    const rows = pickUpRows([chat("t-old", 1), chat("t-new", 3)], [group(10)]);
    expect(rows.map((row) => (row.kind === "thread" ? row.thread.id : row.group.quest.id))).toEqual([
      "t-new",
      "t-old",
      "q1",
    ]);
  });

  it("shows a chat that follows a Quest once, as that Quest", () => {
    const rows = pickUpRows([chat("q1-thread", 3)], [group(10)]);
    expect(rows.map((row) => row.kind)).toEqual(["quest"]);
  });

  it("keeps the five most recent", () => {
    const rows = pickUpRows(
      [1, 2, 3, 4, 5, 6, 7].map((day) => chat(`t${day}`, day)),
      [],
    );
    expect(rows.map((row) => (row.kind === "thread" ? row.thread.id : ""))).toEqual(["t7", "t6", "t5", "t4", "t3"]);
  });
});

describe("questProgress", () => {
  it("counts the party's finished Tasks and the members who wait on you", () => {
    const launch = quest("q1", "aldric");
    const members = [
      memberWork("copy", "quill", launch, "completed"),
      memberWork("build", "ada", launch, "blocked"),
      memberWork("email", "pip", launch, "active"),
    ];
    expect(questProgress({ quest: launch, threadAgentId: launch.leadId, members })).toEqual({
      done: 1,
      total: 3,
      needs: 1,
    });
  });
});
