import { AttemptId, CommandId, CommandRecord, ContentId, TaskId } from "@hobbots/domain";
import { describe, expect, it } from "vitest";
import {
  anyRunning,
  commandDuration,
  commandsInOrder,
  showsLive,
  tallyCommands,
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

  it("follows a running command's output only where the brain reports it as it comes", () => {
    expect(showsLive(command("a", { state: "running", liveOutput: true }))).toBe(true);
    expect(showsLive(command("b", { state: "running", liveOutput: false }))).toBe(false);
    expect(showsLive(command("c", { liveOutput: true }))).toBe(false);
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
