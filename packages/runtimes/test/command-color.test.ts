import { execFileSync } from "node:child_process";
import {
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HookInput } from "@anthropic-ai/claude-agent-sdk";
import type { RuntimeEvent, ToolAccess } from "@hobbots/agents";
import { EMPTY_HOB_POLICY } from "@hobbots/domain";
import { PolicyEngine } from "@hobbots/permissions";
import { Effect, Stream } from "effect";
import { afterAll, describe, expect, it } from "vitest";
import { policyHooks, toolTurn } from "../src/claude-code.ts";
import { commandColorScript, plainBashResponse, writeCommandColorScript } from "../src/command-color.ts";
import { makeFakeRuntime } from "../src/fake.ts";

// Issue #902: a hob's commands print in color for the Workbench, and the hob reads them plain.

const root = realpathSync(mkdtempSync(join(tmpdir(), "hobbots-color-")));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const project = join(root, "project");
const data = join(root, "data");
for (const dir of [project, data]) mkdirSync(dir);

const engine = Effect.runSync(PolicyEngine.pipe(Effect.provide(PolicyEngine.node)));
const access: ToolAccess = {
  policy: { preset: "balanced", sharedFolders: [project], hob: EMPTY_HOB_POLICY, dataFolder: data, restrictions: [] },
  folders: [project],
  runtimeFolder: join(root, "runtime"),
  commitsAs: { _tag: "UserConfig", config: { name: "Ada", email: "ada@example.com" } },
};

const GREEN = "\u001b[32m";
const RESET = "\u001b[m";
const COLORED_DIFF = `\u001b[1mdiff --git a/f b/f${RESET}\n${GREEN}+b${RESET}\n`;

/** Runs `command` in bash after the color script, run twice as Claude Code may, with a git config of the hub's own. */
const withColor = (command: string, cwd: string) => {
  const script = join(root, "command-env.sh");
  writeFileSync(script, commandColorScript());
  return execFileSync("bash", ["-c", `. "${script}"; . "${script}"; ${command}`], {
    cwd,
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      HOME: root,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "user.name",
      GIT_CONFIG_VALUE_0: "Hob",
    },
  });
};

describe("color in a hob's commands", () => {
  // covers UX-006, ADR 014, ADR 023
  it("[TC-RT-501] makes git diff and git status print color through a pipe, and keeps the hub's git settings", () => {
    const repo = join(root, "repo");
    mkdirSync(repo);
    withColor("git init -q && echo a > f && git add f && git -c user.email=h@b commit -qm one && echo b > f", repo);
    expect(withColor("git diff | cat", repo)).toContain(GREEN);
    expect(withColor("git status --short | cat", repo)).toContain("\u001b[");
    // The hub's own setting is still there, and the script ran once though it was sourced twice.
    expect(withColor("git config user.name; echo $GIT_CONFIG_COUNT", repo)).toBe("Hob\n3\n");
    expect(withColor("echo $FORCE_COLOR $CLICOLOR_FORCE $npm_config_color $pnpm_config_color", repo)).toBe(
      "3 1 always always\n",
    );
  });

  // covers ADR 014, STD-SEC-002
  it("[TC-RT-504] replaces a link or hard link a command planted at the script's path, never the file it reaches", async () => {
    const runtime = join(root, "planted-runtime");
    mkdirSync(runtime);
    const outside = join(root, "outside.txt");
    const shared = join(root, "shared.txt");
    writeFileSync(outside, "the user's file\n");
    writeFileSync(shared, "another of the user's files\n");
    const path = join(runtime, "command-env.sh");
    symlinkSync(outside, path);
    await writeCommandColorScript(runtime);
    expect(readFileSync(outside, "utf8")).toBe("the user's file\n");
    expect(lstatSync(path).isFile()).toBe(true);
    expect(readFileSync(path, "utf8")).toBe(commandColorScript());

    rmSync(path);
    linkSync(shared, path);
    await writeCommandColorScript(runtime);
    expect(readFileSync(shared, "utf8")).toBe("another of the user's files\n");
    expect(readFileSync(path, "utf8")).toBe(commandColorScript());
    // Only the script is left: no staged file stays behind.
    expect(readdirSync(runtime)).toEqual(["command-env.sh"]);
  });

  it("writes the script into the hob's runtime folder", async () => {
    const path = await writeCommandColorScript(join(root, "fresh-runtime"));
    expect(path).toBe(join(root, "fresh-runtime", "command-env.sh"));
    expect(readFileSync(path, "utf8")).toBe(commandColorScript());
  });
});

describe("what a hob reads of a colored command", () => {
  it("strips escapes from a Bash response's stdout and stderr, and leaves plain ones alone", () => {
    const response = { stdout: COLORED_DIFF, stderr: `${GREEN}warn${RESET}`, interrupted: false, isImage: false };
    expect(plainBashResponse("Bash", response)).toEqual({
      stdout: "diff --git a/f b/f\n+b\n",
      stderr: "warn",
      interrupted: false,
      isImage: false,
    });
    expect(plainBashResponse("Bash", { stdout: "plain", stderr: "", interrupted: false })).toBeUndefined();
    expect(plainBashResponse("Read", { stdout: COLORED_DIFF })).toBeUndefined();
  });

  // covers UX-006, ADR 023
  it("[TC-RT-502] records a colored command's output on Claude Code and gives the hob the same output without escapes", async () => {
    const turn = toolTurn(access, "on");
    if (turn === null) throw new Error("expected a tool turn");
    const events: Array<RuntimeEvent> = [];
    const { hooks } = policyHooks(engine, turn, (event) => events.push(event), null, null);
    const signal = new AbortController().signal;
    const base = { session_id: "s", transcript_path: "", cwd: project, tool_use_id: "t1" };
    const tool_input = { command: "git diff", description: "Show the diff" };
    await hooks.PreToolUse?.[0]?.hooks[0]?.(
      { ...base, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input } as HookInput,
      "t1",
      { signal },
    );
    const tool_response = { stdout: COLORED_DIFF, stderr: "", interrupted: false, isImage: false };
    const result = await hooks.PostToolUse?.[0]?.hooks[0]?.(
      { ...base, hook_event_name: "PostToolUse", tool_name: "Bash", tool_input, tool_response } as HookInput,
      "t1",
      { signal },
    );
    expect(events.find((event) => event._tag === "ToolFinished")).toMatchObject({ output: COLORED_DIFF });
    expect(result).toEqual({
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        updatedToolOutput: { ...tool_response, stdout: "diff --git a/f b/f\n+b\n" },
      },
    });
  });

  // covers UX-006, ADR 023
  it("[TC-RT-503] records a colored command's output on the fake runtime as it was printed", async () => {
    const output = `${GREEN}✓${RESET} built in 1.2s\n`;
    const events = await makeFakeRuntime({ engine })
      .sendPrompt({
        prompt: `fake:run ${JSON.stringify({ command: "pnpm build", output })}`,
        sessionId: null,
        instructions: "",
        instructionsChanged: false,
        model: null,
        effort: null,
        tools: access,
      })
      .pipe(Stream.runCollect, Effect.runPromise);
    expect(Array.from(events).find((event) => event._tag === "ToolFinished")).toMatchObject({ output });
  });
});
