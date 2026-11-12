import { AgentId, type TaskTree, ThreadId } from "@hobbots/domain";
import { describe, expect, it } from "vitest";
import type { HobState } from "../../lib/hob-state.ts";
import { memberWork, quest } from "../../test/member-work.ts";
import {
  activeFilter,
  homeSummary,
  inFilter,
  peekBench,
  peekThread,
  pickUpRows,
  questProgress,
  sceneChips,
} from "./home-model.ts";

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
  it("shows the Tasks done and what waits on you as the hub's summary counts them", () => {
    const tones = { needs: 1, working: 1, waiting: 0, done: 1, problem: 0, idle: 0 };
    expect(questProgress({ tones, needsYou: 2 } as never)).toEqual({ done: 1, total: 3, needs: 2 });
  });
  it("shows nothing before the summary is read", () =>
    expect(questProgress(undefined)).toEqual({ done: 0, total: 0, needs: 0 }));
});

describe("homeSummary", () => {
  const hob = (name: string, state: HobState) => ({ hob: { name }, state });

  it("names who needs you first, then who is working", () => {
    const crew = [hob("Ada", "needs-you"), hob("Pip", "needs-you"), hob("Aldric", "thinking"), hob("Quill", "idle")];
    expect(homeSummary(crew)).toBe("4 hobs. Ada and Pip need you. Aldric is working.");
  });

  it("says nothing needs you, and leaves out working when no hob works", () => {
    expect(homeSummary([hob("Ada", "idle"), hob("Pip", "paused")])).toBe("2 hobs. Nothing needs you.");
    expect(homeSummary([hob("Ada", "working")])).toBe("1 hob. Nothing needs you. Ada is working.");
  });

  it("names three hobs and counts the rest", () => {
    const crew = ["Ada", "Pip", "Quill", "Bram", "Rook"].map((name) => hob(name, "needs-you"));
    expect(homeSummary(crew)).toBe("5 hobs. Ada, Pip, Quill, and 2 more need you.");
  });

  it("has a line for no hobs", () => expect(homeSummary([])).toBe("No hobs yet."));
});
