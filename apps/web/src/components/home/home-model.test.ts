import { AgentId, type TaskTree, ThreadId } from "@hobbots/domain";
import { describe, expect, it } from "vitest";
import { memberWork, quest } from "../../test/member-work.ts";
import { peekBench, peekThread } from "./home-model.ts";

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
