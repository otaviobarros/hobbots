import {
  AgentId,
  type Attempt,
  type AttemptActivity,
  AttemptId,
  CommandId,
  CommandRecord,
  ContentId,
  type Task,
  TaskId,
  type TaskTree,
} from "@hobbots/domain";
import { describe, expect, it } from "vitest";
import {
  anyRunning,
  commandDuration,
  commandsInOrder,
  hobTerminals,
  tallyCommands,
  terminalAttempts,
  terminalMark,
  wholeOutput,
} from "./terminal-model.ts";

const command = (id: string, fields: Partial<ConstructorParameters<typeof CommandRecord>[0]> = {}) =>
  new CommandRecord({
    id: CommandId.make(id),
    attemptId: AttemptId.make("attempt-1"),
    taskId: TaskId.make("task-1"),
    stepId: `step-${id}`,
    command: `echo ${id}`,
    folder: "/Users/you/notes",
    sandboxed: true,
    liveOutput: false,
    state: "succeeded",
    exitCode: 0,
    startedAt: "2026-11-02T10:00:00.000Z",
    endedAt: "2026-11-02T10:00:03.000Z",
    output: { head: `${id}\n`, tail: "", omittedBytes: 0, totalBytes: 2, logged: false },
    log: null,
    logNotKept: null,
    ...fields,
  });

describe("the Terminal's commands", () => {
  it("lists them in the order they started, keeping the recorded order of two that started together", () => {
    const listed = commandsInOrder([
      command("b", { startedAt: "2026-11-02T10:00:05.000Z" }),
      command("a"),
      command("c", { startedAt: "2026-11-02T10:00:05.000Z" }),
    ]);
    expect(listed.map((each) => each.id)).toEqual(["a", "b", "c"]);
  });

  it("counts the commands, the failed ones and the running ones", () => {
    const commands = [
      command("a"),
      command("b", { state: "failed", exitCode: 1 }),
      command("c", { state: "running", endedAt: null, output: null }),
    ];
    expect(tallyCommands(commands)).toEqual({ total: 3, failed: 1, running: 1 });
    expect(anyRunning(commands)).toBe(true);
    expect(anyRunning(commands.slice(0, 2))).toBe(false);
  });

  it("times a command to its end, or to now while it runs, and not at all when it was cut off", () => {
    const now = new Date("2026-11-02T10:00:12.000Z");
    expect(commandDuration(command("a"), now)).toBe(3000);
    expect(commandDuration(command("b", { state: "running", endedAt: null }), now)).toBe(12_000);
    expect(commandDuration(command("c", { state: "uncertain", endedAt: null }), now)).toBeNull();
  });

  it("opens the whole log only while it is kept, and says why when it is not", () => {
    const log = { contentId: ContentId.make("abc"), totalBytes: 9_000_000, omittedBytes: 4_800_000 };
    expect(wholeOutput(command("a", { log }))).toEqual({ kind: "log", totalBytes: 9_000_000, omittedBytes: 4_800_000 });
    expect(wholeOutput(command("b", { log, logNotKept: "cleared" }))).toEqual({ kind: "not-kept", reason: "cleared" });
    expect(wholeOutput(command("c", { logNotKept: "attempt-limit" }))).toEqual({
      kind: "not-kept",
      reason: "attempt-limit",
    });
    expect(wholeOutput(command("d"))).toEqual({ kind: "not-kept", reason: null });
  });
});

describe("the Terminal's hobs", () => {
  const task = (id: string, ownerId: string, parentId: string | null = null) =>
    ({ id: TaskId.make(id), ownerId: AgentId.make(ownerId), parentId }) as unknown as Task;
  const attempt = (id: string, taskId: string, number: number) =>
    ({ id: AttemptId.make(id), taskId: TaskId.make(taskId), number }) as unknown as Attempt;
  const lead = task("lead", "aldric");
  const tree = {
    tasks: [lead, task("copy", "quill", "lead"), task("build", "ada", "lead"), task("idle", "pip", "lead")],
    attempts: [attempt("l1", "lead", 1), attempt("c1", "copy", 1), attempt("c2", "copy", 2), attempt("b1", "build", 1)],
  } as unknown as TaskTree;

  it("replays the shown Attempt for the Task and the latest for every other Task that has one", () => {
    const shown = tree.attempts[0] ?? null;
    expect(terminalAttempts(tree, lead, shown).map((each) => each.id)).toEqual(["l1", "c2", "b1"]);
    expect(terminalAttempts(tree, lead, null).map((each) => each.id)).toEqual(["c2", "b1"]);
  });

  it("gives each hob that ran a command one terminal, the Task's own hob first", () => {
    const ran = (taskId: string, id: string, startedAt: string) =>
      command(id, { taskId: TaskId.make(taskId), startedAt });
    const activities = [
      { commands: [ran("build", "b", "2026-11-02T10:00:01.000Z")] },
      { commands: [ran("copy", "c", "2026-11-02T10:00:02.000Z"), ran("lead", "a", "2026-11-02T10:00:03.000Z")] },
    ] as unknown as ReadonlyArray<AttemptActivity>;
    const terminals = hobTerminals(tree, tree.tasks[2] as Task, activities);
    expect(terminals.map((each) => [each.ownerId, each.commands.map((one) => one.id)])).toEqual([
      ["ada", ["b"]],
      ["aldric", ["a"]],
      ["quill", ["c"]],
    ]);
  });

  it("marks a terminal running while a command runs, and failed when its last command failed", () => {
    expect(terminalMark([command("a"), command("b", { state: "running" })])).toBe("running");
    expect(terminalMark([command("a", { state: "failed" })])).toBe("failed");
    expect(terminalMark([command("a", { state: "failed" }), command("b")])).toBe("idle");
  });
});
