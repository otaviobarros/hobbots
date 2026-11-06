import { linkSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HookInput } from "@anthropic-ai/claude-agent-sdk";
import type { RuntimeEvent, ToolAccess } from "@hobbots/agents";
import { EMPTY_HOB_POLICY } from "@hobbots/domain";
import { PolicyEngine } from "@hobbots/permissions";
import { Effect, Stream } from "effect";
import { afterAll, describe, expect, it } from "vitest";
import { backgroundCommands, backgroundFinished, isTaskEnd, type TaskEnd } from "../src/background-commands.ts";
import { policyHooks, toolTurn } from "../src/claude-code.ts";
import { makeFakeRuntime } from "../src/fake.ts";

// Issue #1018: a command Claude Code runs in the background finishes when its task ends, not when
// its call returns.

const root = realpathSync(mkdtempSync(join(tmpdir(), "hobbots-background-")));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const project = join(root, "project");
const data = join(root, "data");
const tasks = join(root, "tasks");
for (const dir of [project, data, tasks]) mkdirSync(dir);

const engine = Effect.runSync(PolicyEngine.pipe(Effect.provide(PolicyEngine.node)));

const access: ToolAccess = {
  policy: { preset: "balanced", sharedFolders: [project], hob: EMPTY_HOB_POLICY, dataFolder: data, restrictions: [] },
  folders: [project],
  runtimeFolder: join(root, "runtime"),
};

/** What Claude Code's PostToolUse hook gets for a Bash call that went on in the background. */
const backgrounded = {
  hook_event_name: "PostToolUse",
  tool_name: "Bash",
  tool_input: { command: "pnpm dev", run_in_background: true },
  tool_response: { stdout: "", stderr: "", interrupted: false, isImage: false, backgroundTaskId: "b7x2k" },
} as const;

/** The task's end, as Claude Code's `task_notification` message reports it. */
const taskEnd = (fields: Partial<TaskEnd> = {}) => ({
  type: "system",
  subtype: "task_notification",
  task_id: "b7x2k",
  tool_use_id: "t1",
  status: "completed",
  output_file: "",
  summary: 'Background command "pnpm dev" completed (exit code 0)',
  uuid: "u",
  session_id: "s",
  ...fields,
});

/** Runs a Bash call through the hooks and then hands the turn the given task notifications. */
const turnWith = async (post: object, ends: ReadonlyArray<object>) => {
  const turn = toolTurn(access, "on");
  if (turn === null) throw new Error("expected a tool turn");
  const events: Array<RuntimeEvent> = [];
  const report = (event: RuntimeEvent) => events.push(event);
  const background = backgroundCommands(report);
  const { hooks } = policyHooks(engine, turn, report, null, null, undefined, background);
  const signal = new AbortController().signal;
  const base = { session_id: "s", transcript_path: "", cwd: project, tool_use_id: "t1" };
  const [pre] = hooks.PreToolUse?.[0]?.hooks ?? [];
  await pre?.(
    { ...base, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: backgrounded.tool_input } as HookInput,
    "t1",
    { signal },
  );
  await hooks.PostToolUse?.[0]?.hooks[0]?.({ ...base, ...post } as unknown as HookInput, "t1", { signal });
  const returned = events.map((event) => event._tag);
  for (const end of ends) if (isTaskEnd(end)) await background.ended(end);
  return { returned, events };
};

describe("a background command on Claude Code", () => {
  // covers UX-006, EX-004
  it("[TC-RT-1018-01] stays running when its call returns, and finishes with its output and exit code when its task ends", async () => {
    const output = join(tasks, "b7x2k.output");
    writeFileSync(output, "ready on http://localhost:5173\n");
    const { returned, events } = await turnWith(backgrounded, [taskEnd({ output_file: output })]);
    expect(returned).toEqual(["ToolStarted"]);
    expect(events.at(-1)).toEqual({
      _tag: "ToolFinished",
      id: "t1",
      failed: false,
      output: "ready on http://localhost:5173\n",
      exitCode: 0,
    });
  });

  // covers UX-006
  it("[TC-RT-1018-02] fails with its exit code when its task fails, and without one when it is stopped", async () => {
    const failed = await turnWith(backgrounded, [
      taskEnd({ status: "failed", summary: 'Background command "pnpm dev" failed with exit code 1' }),
    ]);
    expect(failed.events.at(-1)).toEqual({ _tag: "ToolFinished", id: "t1", failed: true, exitCode: 1 });
    const stopped = await turnWith(backgrounded, [
      taskEnd({ status: "stopped", summary: 'Background command "pnpm dev" was stopped' }),
    ]);
    expect(stopped.events.at(-1)).toEqual({ _tag: "ToolFinished", id: "t1", failed: true });
  });

  // covers UX-006
  it("[TC-RT-1018-03] ignores tasks that are not its background commands, and a call that ended in the foreground finishes at once", async () => {
    const other = await turnWith(backgrounded, [taskEnd({ task_id: "agent-1", tool_use_id: "t9" })]);
    expect(other.events.map((event) => event._tag)).toEqual(["ToolStarted"]);
    const foreground = await turnWith(
      { ...backgrounded, tool_response: { stdout: "ok\n", stderr: "", interrupted: false, isImage: false } },
      [taskEnd()],
    );
    expect(foreground.returned).toEqual(["ToolStarted", "ToolFinished"]);
    expect(foreground.events).toHaveLength(2);
  });

  it("finishes a call whose task ended before its hook said it went to the background", async () => {
    const events: Array<RuntimeEvent> = [];
    const background = backgroundCommands((event) => events.push(event));
    await background.ended(taskEnd() as TaskEnd);
    expect(events).toEqual([]);
    expect(await background.moved("t1", backgrounded)).toBe(true);
    expect(events).toEqual([{ _tag: "ToolFinished", id: "t1", failed: false, exitCode: 0 }]);
  });

  it("reads the exit code only from the end of the summary, not from the command's own words", () => {
    const summary = 'Background command "echo \\"exit code 7\\"" completed (exit code 0: note)';
    expect(backgroundFinished("t1", { status: "completed", summary }, undefined)).toEqual({
      _tag: "ToolFinished",
      id: "t1",
      failed: false,
      exitCode: 0,
    });
    expect(backgroundFinished("t1", { status: "completed", summary: "done" }, "x")).toEqual({
      _tag: "ToolFinished",
      id: "t1",
      failed: false,
      output: "x",
    });
  });

  it("leaves out an output file linked from elsewhere", async () => {
    const secret = join(root, "secret.txt");
    writeFileSync(secret, "token\n");
    const linked = join(tasks, "linked.output");
    linkSync(secret, linked);
    const { events } = await turnWith(backgrounded, [taskEnd({ output_file: linked })]);
    expect(events.at(-1)).toEqual({ _tag: "ToolFinished", id: "t1", failed: false, exitCode: 0 });
  });
});

/** The events of a fake turn with the given prompt. */
const fakeTurn = (prompt: string) =>
  makeFakeRuntime({ engine })
    .sendPrompt({
      prompt,
      sessionId: null,
      instructions: "",
      instructionsChanged: false,
      model: null,
      effort: null,
      tools: access,
    })
    .pipe(Stream.runCollect, Effect.runPromise)
    .then((events) => Array.from(events));

describe("a background command on the fake runtime", () => {
  // covers UX-006
  it("[TC-RT-1018-04] returns at once, lets the turn go on, and ends with its outcome before the turn completes", async () => {
    const events = await fakeTurn(
      [
        `fake:run ${JSON.stringify({ command: "pnpm dev", background: true, runsFor: "50 millis", output: "ready\n", exitCode: 2 })}`,
        "fake:tool Bash echo checked",
      ].join("\n"),
    );
    const steps = events.flatMap((event) =>
      event._tag === "ToolStarted" || event._tag === "ToolFinished" || event._tag === "Completed"
        ? [`${event._tag}${"id" in event ? ` ${event.id}` : ""}`]
        : [],
    );
    expect(steps).toEqual([
      "ToolStarted fake-tool-1",
      "ToolStarted fake-tool-2",
      "ToolFinished fake-tool-2",
      "ToolFinished fake-tool-1",
      "Completed",
    ]);
    expect(events.find((event) => event._tag === "ToolFinished" && event.id === "fake-tool-1")).toEqual({
      _tag: "ToolFinished",
      id: "fake-tool-1",
      failed: true,
      output: "ready\n",
      exitCode: 2,
    });
  });

  // covers UX-006
  it("[TC-RT-1018-05] with no time to run for, is still running when the turn completes", async () => {
    const events = await fakeTurn(`fake:run ${JSON.stringify({ command: "pnpm dev", background: true })}`);
    expect(events.filter((event) => event._tag === "ToolFinished")).toEqual([]);
    expect(events.at(-1)?._tag).toBe("Completed");
  });
});
