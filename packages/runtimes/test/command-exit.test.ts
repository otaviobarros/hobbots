import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HookInput } from "@anthropic-ai/claude-agent-sdk";
import type { RuntimeEvent, ToolAccess } from "@hobbots/agents";
import { EMPTY_HOB_POLICY } from "@hobbots/domain";
import { PolicyEngine } from "@hobbots/permissions";
import { Effect, Stream } from "effect";
import { afterAll, describe, expect, it } from "vitest";
import { policyHooks, toolTurn } from "../src/claude-code.ts";
import { makeFakeRuntime } from "../src/fake.ts";
import { RECORDED_BASH_HOOKS } from "./claude-code-bash-hooks.ts";

// Issue #591: a command's exit code, from what Claude Code's hooks report, and the fake's the same way.

const root = realpathSync(mkdtempSync(join(tmpdir(), "hobbots-exit-")));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const project = join(root, "project");
const data = join(root, "data");
for (const dir of [project, data]) mkdirSync(dir);

const engine = Effect.runSync(PolicyEngine.pipe(Effect.provide(PolicyEngine.node)));

const access: ToolAccess = {
  policy: { preset: "balanced", sharedFolders: [project], hob: EMPTY_HOB_POLICY, dataFolder: data, restrictions: [] },
  folders: [project],
  runtimeFolder: join(root, "runtime"),
};

type Recorded = (typeof RECORDED_BASH_HOOKS)[keyof typeof RECORDED_BASH_HOOKS];

/** How the Claude Code turn reports a recorded command's end, through its PreToolUse and Post hooks. */
const realEnd = async (recorded: Recorded) => {
  const turn = toolTurn(access, "on");
  if (turn === null) throw new Error("expected a tool turn");
  const events: Array<RuntimeEvent> = [];
  const { hooks } = policyHooks(engine, turn, (event) => events.push(event), null, null);
  const signal = new AbortController().signal;
  const base = { session_id: "s", transcript_path: "", cwd: project, tool_use_id: "t1" };
  const [pre] = hooks.PreToolUse?.[0]?.hooks ?? [];
  const { tool_name, tool_input } = recorded;
  await pre?.({ ...base, hook_event_name: "PreToolUse", tool_name, tool_input } as HookInput, "t1", { signal });
  const post = recorded.hook_event_name === "PostToolUse" ? hooks.PostToolUse : hooks.PostToolUseFailure;
  await post?.[0]?.hooks[0]?.({ ...base, ...recorded } as unknown as HookInput, "t1", { signal });
  return events.find((event) => event._tag === "ToolFinished");
};

/** How the fake runtime reports a scripted command's end. */
const fakeEnd = async (command: string, effect: { readonly output?: string; readonly exitCode?: number }) => {
  const events = await makeFakeRuntime({ engine })
    .sendPrompt({
      prompt: `fake:run ${JSON.stringify({ command, ...effect })}`,
      sessionId: null,
      instructions: "",
      instructionsChanged: false,
      model: null,
      effort: null,
      tools: access,
    })
    .pipe(Stream.runCollect, Effect.runPromise);
  const finished = Array.from(events).find((event) => event._tag === "ToolFinished");
  // The fake names its calls itself; only how the call ended is compared.
  return finished === undefined ? undefined : { ...finished, id: "t1" };
};

describe("a command's exit code on Claude Code", () => {
  // covers UX-006, ADR 023
  it("[TC-RT-100] reports exit code 1 for `false` and 0 for `true`, from Claude Code's recorded hook payloads", async () => {
    expect(await realEnd(RECORDED_BASH_HOOKS.false)).toEqual({
      _tag: "ToolFinished",
      id: "t1",
      failed: true,
      exitCode: 1,
    });
    expect(await realEnd(RECORDED_BASH_HOOKS.true)).toEqual({
      _tag: "ToolFinished",
      id: "t1",
      failed: false,
      exitCode: 0,
    });
  });

  // covers UX-006, ADR 023
  it("[TC-RT-101] keeps what a failed command printed without Claude Code's exit code line", async () => {
    expect(await realEnd(RECORDED_BASH_HOOKS.printsThenExits2)).toEqual({
      _tag: "ToolFinished",
      id: "t1",
      failed: true,
      output: "before\noops",
      exitCode: 2,
    });
  });

  // covers UX-006, ADR 023
  it("[TC-RT-102] records no exit code where Claude Code reads a non-zero one as no error and does not say which", async () => {
    expect(await realEnd(RECORDED_BASH_HOOKS.grepNoMatch)).toEqual({ _tag: "ToolFinished", id: "t1", failed: false });
  });

  // covers UX-006, ADR 023
  it("[TC-RT-103] reports a fake runtime's command exactly as the real runtime reports the same command", async () => {
    expect(await fakeEnd("false", { exitCode: 1 })).toEqual(await realEnd(RECORDED_BASH_HOOKS.false));
    expect(await fakeEnd("true", { exitCode: 0 })).toEqual(await realEnd(RECORDED_BASH_HOOKS.true));
    expect(await fakeEnd("true", {})).toEqual(await realEnd(RECORDED_BASH_HOOKS.true));
    expect(await fakeEnd("echo before; echo oops >&2; exit 2", { output: "before\noops", exitCode: 2 })).toEqual(
      await realEnd(RECORDED_BASH_HOOKS.printsThenExits2),
    );
  });
});
