import { spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, relative, resolve } from "node:path";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { RuntimeLimitReached } from "@hobbots/agents";
import { policySandbox } from "@hobbots/domain";
import { PolicyEngine } from "@hobbots/permissions";
import { Duration, Effect, Exit, Fiber, Layer, Stream } from "effect";
import { TestClock } from "effect/testing";
import { afterAll, describe, expect, it } from "vitest";
import {
  APPROVAL_NOTE,
  brainOptions,
  type ClaudeCodeConfig,
  claudeCandidates,
  exited,
  expiringCache,
  fallbackModels,
  findClaudeCode,
  isAtLeast,
  makeClaudeCode as makeAdapter,
  modelListMaxAge,
  parseVersion,
  runtimePath,
  SANDBOX_NOTE,
  stderrTail,
  toRuntimeModels,
  turnEvents,
  turnInstructions,
  turnPrompt,
} from "../src/claude-code.ts";
import { ProcessSandbox } from "../src/sandbox.ts";

// These turns are chat-only, so the adapter runs without a sandbox.
const makeClaudeCode = (config: ClaudeCodeConfig) =>
  makeAdapter(config).pipe(
    Effect.provide(Layer.mergeAll(PolicyEngine.node, ProcessSandbox.unavailable("not needed for chat-only turns"))),
  );

const temp = mkdtempSync(join(tmpdir(), "hobbots-claude-"));
afterAll(() => rmSync(temp, { recursive: true, force: true }));
let homes = 0;
const newHome = () => {
  const home = join(temp, `home-${homes++}`);
  mkdirSync(home);
  return home;
};

const executableAt = (path: string, script = "#!/bin/sh\n") => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, script);
  chmodSync(path, 0o755);
  return path;
};

describe("finding the host's Claude Code", () => {
  it("checks the installers' own locations before PATH", () => {
    expect(claudeCandidates({ PATH: ["/usr/bin", "", "/bin"].join(delimiter) }, "/Users/me")).toEqual([
      "/Users/me/.local/bin/claude",
      "/Users/me/.claude/local/claude",
      "/opt/homebrew/bin/claude",
      "/usr/local/bin/claude",
      "/usr/bin/claude",
      "/bin/claude",
    ]);
  });

  it("finds the native install with a bare PATH, as an app opened from Finder has", () => {
    const home = newHome();
    executableAt(join(home, ".local", "bin", "claude"));
    expect(findClaudeCode(undefined, { PATH: "/usr/bin" }, home, [])).toBe(join(home, ".local", "bin", "claude"));
  });

  it("skips files that are not executable and falls back to PATH", () => {
    const home = newHome();
    mkdirSync(join(home, ".local", "bin"), { recursive: true });
    writeFileSync(join(home, ".local", "bin", "claude"), "");
    const bin = join(home, "bin");
    executableAt(join(bin, "claude"));
    expect(findClaudeCode(undefined, { PATH: bin }, home, [])).toBe(join(bin, "claude"));
  });

  it("prefers a configured binary and reports none when nothing is installed", () => {
    const home = newHome();
    expect(findClaudeCode(" /custom/claude ", { PATH: "" }, home, [])).toBe("/custom/claude");
    expect(findClaudeCode(undefined, { PATH: join(home, "missing") }, home, [])).toBeUndefined();
    expect(findClaudeCode(" ", { PATH: `.${delimiter}${join(home, "missing")}` }, home, [])).toBeUndefined();
  });

  it("resolves a relative override against the server's folder and keeps a bare name as a PATH lookup", () => {
    const home = newHome();
    expect(findClaudeCode("./tools/claude", { PATH: "" }, home, [])).toBe(resolve("tools", "claude"));
    expect(findClaudeCode("claude", { PATH: "" }, home, [])).toBe("claude");
  });

  it("gives Claude Code a PATH with its own folder and the installers' folders", () => {
    expect(runtimePath("/opt/homebrew/bin/claude", { PATH: "/usr/bin" }, "/Users/me").split(delimiter)).toEqual([
      "/opt/homebrew/bin",
      "/Users/me/.local/bin",
      "/Users/me/.claude/local",
      "/usr/local/bin",
      "/usr/bin",
    ]);
  });
});

describe("Claude Code versions", () => {
  it("reads the version `claude --version` prints", () => {
    expect(parseVersion("2.1.301 (Claude Code)\n")).toBe("2.1.301");
    expect(parseVersion("command not found")).toBeUndefined();
  });

  it("compares numerically, not as text", () => {
    expect(isAtLeast("2.1.301", "2.1.301")).toBe(true);
    expect(isAtLeast("2.1.1000", "2.1.301")).toBe(true);
    expect(isAtLeast("2.10.0", "2.9.9")).toBe(true);
    expect(isAtLeast("2.1.300", "2.1.301")).toBe(false);
    expect(isAtLeast("1.9.999", "2.0.0")).toBe(false);
  });
});

describe("Claude Code health before the runtime starts", () => {
  const adapterFor = (script: string, executable = join(newHome(), "claude")) =>
    makeClaudeCode({ workspaceDir: join(temp, "workspace"), executable: executableAt(executable, script) });
  const turn = (adapter: Effect.Success<ReturnType<typeof makeClaudeCode>>) =>
    Effect.runPromiseExit(
      Stream.runDrain(
        adapter.sendPrompt({
          prompt: "hi",
          sessionId: null,
          instructions: "",
          instructionsChanged: false,
          model: null,
          effort: null,
        }),
      ),
    );

  it("reports an old release as outdated and refuses chat turns with update guidance", async () => {
    const adapter = await Effect.runPromise(adapterFor('#!/bin/sh\necho "2.1.200 (Claude Code)"\n'));
    const health = await Effect.runPromise(adapter.health);
    expect((await Effect.runPromise(adapter.models)).source).toBe("fallback");
    expect(health.availability).toBe("outdated");
    expect(health.version).toBe("2.1.200");
    const refused = await turn(adapter);
    expect(Exit.isFailure(refused) && String(refused.cause)).toContain("claude update");
  });

  it("checks the version again once `claude update` replaces the binary", async () => {
    const executable = join(newHome(), "claude");
    const adapter = await Effect.runPromise(adapterFor('#!/bin/sh\necho "2.1.200 (Claude Code)"\n', executable));
    expect((await Effect.runPromise(adapter.health)).availability).toBe("outdated");
    executableAt(executable, '#!/bin/sh\necho "2.1.999 (Claude Code)"\n');
    const later = new Date(Date.now() + 60_000);
    utimesSync(executable, later, later);
    // The stand-in cannot run a session, so the probe that follows fails; the version is what matters.
    const health = await Effect.runPromise(adapter.health);
    expect(health.version).toBe("2.1.999");
    expect(health.availability).not.toBe("outdated");
  }, 40_000);

  it("starts a relative override from the server's folder, not the runtime's workspace", async () => {
    const home = newHome();
    const started = join(home, "started");
    // Prints a current version; any other call is the SDK starting it, which leaves a marker and exits.
    const binary = executableAt(
      join(home, "claude"),
      `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "2.1.999 (Claude Code)"; else touch "${started}"; fi\n`,
    );
    const adapter = await Effect.runPromise(
      makeClaudeCode({ workspaceDir: join(temp, "workspace"), executable: relative(process.cwd(), binary) }),
    );
    const health = await Effect.runPromise(adapter.health);
    expect(health.version).toBe("2.1.999");
    expect(existsSync(started)).toBe(true);
  }, 40_000);

  it("reports a configured binary that does not exist as unavailable, not as an error", async () => {
    const adapter = await Effect.runPromise(
      makeClaudeCode({ workspaceDir: join(temp, "workspace"), executable: join(newHome(), "missing", "claude") }),
    );
    const health = await Effect.runPromise(adapter.health);
    expect(health.availability).toBe("unavailable");
    expect(health.version).toBeNull();
    const refused = await turn(adapter);
    expect(Exit.isFailure(refused) && String(refused.cause)).toContain("could not be started");
  });

  // covers PE-005
  it("[TC-PE-041] declares the sandbox unsupported, with why, in its enforcement and its health", async () => {
    const adapter = await Effect.runPromise(
      makeClaudeCode({ workspaceDir: join(temp, "workspace"), executable: join(newHome(), "missing", "claude") }),
    );
    const declared = await Effect.runPromise(adapter.enforcement);
    expect(declared.processSandbox).toEqual({ status: "unsupported", evidence: "not needed for chat-only turns" });
    expect(declared.toolInterception.status).toBe("verified");
    // Health carries the same declaration whatever the runtime's availability.
    expect((await Effect.runPromise(adapter.health)).enforcement).toEqual(declared);
    // Tools are then decided as without the sandbox: commands, local Git and the web are blocked.
    expect(policySandbox(declared)).toBe("unavailable");
  });

  it("reports a binary that prints no version as unavailable", async () => {
    const adapter = await Effect.runPromise(adapterFor("#!/bin/sh\necho nope\n"));
    const health = await Effect.runPromise(adapter.health);
    expect(health.availability).toBe("unavailable");
    expect(health.version).toBeNull();
    const refused = await turn(adapter);
    expect(Exit.isFailure(refused) && String(refused.cause)).toContain("could not be started");
  });
});

describe("a hob's brain on Claude Code", () => {
  it("passes the hob's model and effort, and leaves Claude Code's defaults when they are unset", () => {
    expect(brainOptions({ model: "sonnet", effort: "high" })).toEqual({ model: "sonnet", effort: "high" });
    expect(brainOptions({ model: null, effort: null })).toEqual({});
  });

  it("offers the models Claude Code reports, with no effort for a model that takes none", () => {
    const models = toRuntimeModels([
      {
        value: "sonnet",
        displayName: "Sonnet",
        description: "Efficient",
        supportsEffort: true,
        supportedEffortLevels: ["low", "high"],
      },
      { value: "claude-haiku-4-5", displayName: "Haiku 4.5", description: "Fast", supportedEffortLevels: ["low"] },
    ]);
    expect(models.source).toBe("runtime");
    expect(models.models.map((m) => [m.id, m.efforts])).toEqual([
      ["sonnet", ["low", "high"]],
      ["claude-haiku-4-5", []],
    ]);
  });

  it("counts Claude Code's aliases as main models and pinned ids as older versions", () => {
    const models = toRuntimeModels([
      { value: "default", displayName: "Default", description: "" },
      { value: "opus", displayName: "Opus", description: "" },
      { value: "claude-opus-4-8", displayName: "Opus 4.8", description: "" },
    ]);
    expect(models.models.map((m) => [m.id, m.main])).toEqual([
      ["default", true],
      ["opus", true],
      ["claude-opus-4-8", false],
    ]);
  });

  it("falls back to the documented aliases, starting with Claude Code's default", () => {
    expect(fallbackModels.models.map((m) => m.id)).toEqual(["default", "opus", "fable", "sonnet", "haiku"]);
  });
});

const isRunning = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const until = async (check: () => boolean, ms = 5000) => {
  const deadline = Date.now() + ms;
  while (!check() && Date.now() < deadline) await new Promise((done) => setTimeout(done, 50));
  return check();
};

describe("a hob's instructions on a resumed Claude Code session", () => {
  const request = { prompt: "hi", instructions: "Be thorough.", instructionsChanged: true };

  it("carries the instructions in the turn when the session may follow others, since Claude Code keeps a resumed session's system prompt", () => {
    expect(turnPrompt({ ...request, sessionId: "s1" })).toBe(
      "<current-instructions>\nThese are your current instructions. Follow them in place of the ones in your system prompt and any earlier ones:\n\nBe thorough.\n</current-instructions>\n\nhi",
    );
  });

  it("sends the prompt alone to a new session or one that follows them", () => {
    expect(turnPrompt({ ...request, sessionId: null })).toBe("hi");
    expect(turnPrompt({ ...request, sessionId: "s1", instructionsChanged: false })).toBe("hi");
  });

  // covers RT-001
  it("[TC-CH-185] delivers a briefing on what the session missed after the instructions and before the prompt", () => {
    expect(turnPrompt({ ...request, sessionId: null, briefing: "## This thread so far" })).toBe(
      "## This thread so far\n\nhi",
    );
    expect(turnPrompt({ ...request, sessionId: "s1", briefing: "## Since your last reply" })).toMatch(
      /<\/current-instructions>\n\n## Since your last reply\n\nhi$/,
    );
    expect(turnPrompt({ ...request, sessionId: "s1", instructionsChanged: false, briefing: null })).toBe("hi");
  });
});

describe("asking Claude Code for its models", () => {
  // covers AG-005
  it("[TC-AG-005] closes a Claude Code that never answers when the check times out", async () => {
    const pidFile = join(newHome(), "pid");
    const executable = executableAt(
      join(newHome(), "claude"),
      `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "2.1.400 (Claude Code)"; exit 0; fi\necho $$ > "${pidFile}"\nexec sleep 60\n`,
    );
    const adapter = await Effect.runPromise(
      makeClaudeCode({ workspaceDir: join(temp, "workspace"), executable, checkTimeout: "1 second" }),
    );

    const listed = await Effect.runPromise(adapter.models);

    expect(listed.source).toBe("fallback");
    expect(await until(() => existsSync(pidFile))).toBe(true);
    const pid = Number(readFileSync(pidFile, "utf8").trim());
    expect(await until(() => !isRunning(pid))).toBe(true);
  });

  // covers AG-005
  it("[TC-AG-006] asks again once a list expires, though the binary is unchanged", async () => {
    const lists = [
      { ...fallbackModels, source: "runtime" as const, models: fallbackModels.models.slice(0, 2) },
      { ...fallbackModels, source: "runtime" as const, models: fallbackModels.models.slice(0, 1) },
    ];
    let asked = 0;
    const load = Effect.sync(() => lists[Math.min(asked++, lists.length - 1)] ?? fallbackModels);
    const cached = expiringCache(modelListMaxAge);

    const seen = await Effect.runPromise(
      Effect.gen(function* () {
        const first = yield* cached("claude@2.1.400", load);
        yield* TestClock.adjust(Duration.minutes(4));
        const kept = yield* cached("claude@2.1.400", load);
        yield* TestClock.adjust(Duration.minutes(2));
        const refreshed = yield* cached("claude@2.1.400", load);
        return [first, kept, refreshed].map((list) => list.models.length);
      }).pipe(Effect.provide(Layer.fresh(TestClock.layer()))),
    );

    expect(seen).toEqual([2, 2, 1]);
    expect(asked).toBe(2);
  });

  it("keeps a fallback list for a shorter time, so a runtime that did not answer is asked again soon", () => {
    expect(Duration.toMillis(modelListMaxAge(fallbackModels))).toBeLessThan(
      Duration.toMillis(modelListMaxAge({ ...fallbackModels, source: "runtime" })),
    );
  });
});

describe("stopping a Claude Code turn", () => {
  // covers CH-007
  it("[TC-CH-020] ends a cancelled turn only once Claude Code has exited, even while a read is pending", async () => {
    const pidFile = join(newHome(), "pid");
    // Never answers, ignores the end of its input and takes a moment to exit once asked to stop.
    const executable = executableAt(
      join(newHome(), "claude"),
      `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "2.1.400 (Claude Code)"; exit 0; fi\necho $$ > "${pidFile}"\ntrap 'sleep 1; exit 0' TERM\nwhile :; do sleep 0.1; done\n`,
    );
    const adapter = await Effect.runPromise(makeClaudeCode({ workspaceDir: join(temp, "workspace"), executable }));
    const turn = Effect.runFork(
      Stream.runDrain(
        adapter.sendPrompt({
          prompt: "hi",
          sessionId: null,
          instructions: "",
          instructionsChanged: false,
          model: null,
          effort: null,
        }),
      ),
    );
    expect(await until(() => existsSync(pidFile))).toBe(true);
    const pid = Number(readFileSync(pidFile, "utf8").trim());

    await Effect.runPromise(Fiber.interrupt(turn));

    expect(isRunning(pid)).toBe(false);
  }, 20_000);

  // covers CH-007
  it("[TC-CH-021] kills a Claude Code that is still running after the grace period", async () => {
    const child = spawn("/bin/sh", ["-c", "trap '' TERM; echo ready; while :; do sleep 0.1; done"], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    await new Promise((ready) => child.stdout.once("data", ready));
    child.kill("SIGTERM");

    await Effect.runPromise(exited(child, "200 millis"));

    expect(child.signalCode).toBe("SIGKILL");
  });
});

describe("a Claude Code turn that fails", () => {
  // covers CH-004
  it("[TC-CH-022] shows what Claude Code wrote to stderr when its process fails", async () => {
    const executable = executableAt(
      join(newHome(), "claude"),
      `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "2.1.400 (Claude Code)"; exit 0; fi\necho "Error: model not available" >&2\nexit 1\n`,
    );
    const adapter = await Effect.runPromise(makeClaudeCode({ workspaceDir: join(temp, "workspace"), executable }));

    const exit = await Effect.runPromiseExit(
      Stream.runDrain(
        adapter.sendPrompt({
          prompt: "hi",
          sessionId: null,
          instructions: "",
          instructionsChanged: false,
          model: null,
          effort: null,
        }),
      ),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    expect(JSON.stringify(exit)).toContain("Error: model not available");
  });

  // covers CH-004
  it("[TC-CH-023] keeps only the end of a long error output", async () => {
    const child = spawn("/bin/sh", ["-c", "head -c 5000 /dev/zero | tr '\\0' x >&2; echo >&2; echo the end >&2"], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    const tail = await Effect.runPromise(stderrTail(child.stderr, 100).read);

    expect(tail.length).toBeLessThanOrEqual(100);
    expect(tail.endsWith("x\nthe end")).toBe(true);
  });
});

describe("reading a Claude Code turn", () => {
  const stream = (event: unknown) => ({ type: "stream_event", parent_tool_use_id: null, event }) as SDKMessage;

  it("[TC-CH-096] shows each thinking block as a step that ends when the block stops", () => {
    const read = turnEvents();
    expect(read(stream({ type: "content_block_start", index: 0, content_block: { type: "thinking" } }))).toEqual([
      { _tag: "StepStarted", id: "thinking-1", kind: "thinking", label: "Thinking" },
    ]);
    expect(read(stream({ type: "content_block_start", index: 1, content_block: { type: "text" } }))).toEqual([]);
    expect(read(stream({ type: "content_block_stop", index: 0 }))).toEqual([{ _tag: "StepEnded", id: "thinking-1" }]);
    // A block left open ends with its message, and the next message counts on.
    read(stream({ type: "content_block_start", index: 0, content_block: { type: "redacted_thinking" } }));
    expect(read(stream({ type: "message_stop" }))).toEqual([{ _tag: "StepEnded", id: "thinking-2" }]);
  });

  it("[TC-CH-097] ends the turn at a rejected rate limit, with when it resets, unless overage covers it", () => {
    const read = turnEvents();
    const limit = (info: Record<string, unknown>) =>
      ({ type: "rate_limit_event", rate_limit_info: info, uuid: "u", session_id: "s" }) as unknown as SDKMessage;
    expect(read(limit({ status: "allowed_warning" }))).toEqual([]);
    expect(read(limit({ status: "rejected", overageStatus: "allowed" }))).toEqual([]);
    expect(() => read(limit({ status: "rejected", resetsAt: 1_800_000_000 }))).toThrow(
      new RuntimeLimitReached({ resetsAt: new Date(1_800_000_000_000).toISOString() }),
    );
  });
});

describe("the sandbox note", () => {
  // covers PE-005
  it("[TC-PE-087] tells a sandboxed turn that Git's config and hooks are read-only, and no other turn", () => {
    expect(turnInstructions("Be brief.", true)).toBe(`Be brief.\n\n${SANDBOX_NOTE}`);
    expect(turnInstructions("", true)).toBe(SANDBOX_NOTE);
    expect(turnInstructions("Be brief.", false)).toBe("Be brief.");
    expect(SANDBOX_NOTE).toContain("could not write config file .git/config: Operation not permitted");
  });
});

describe("the approval note", () => {
  // covers PE-003; regression for #282
  it("[TC-PE-123] tells a turn that can ask the user that it never sees the request, and no other turn", () => {
    expect(turnInstructions("Be brief.", false, true)).toBe(`Be brief.\n\n${APPROVAL_NOTE}`);
    expect(turnInstructions("Be brief.", true, true)).toBe(`Be brief.\n\n${APPROVAL_NOTE}\n\n${SANDBOX_NOTE}`);
    expect(turnInstructions("Be brief.", false)).toBe("Be brief.");
    expect(APPROVAL_NOTE).toContain("you do not");
  });

  // covers PE-003; regression for #282
  it("[TC-PE-124] carries the approval note to a resumed session with its instructions, since it keeps its system prompt", () => {
    const request = { prompt: "hi", instructions: "Be brief.", instructionsChanged: true, sessionId: "s1" };
    const prompt = turnPrompt(request, turnInstructions(request.instructions, false, true));
    expect(prompt).toContain(`Be brief.\n\n${APPROVAL_NOTE}\n</current-instructions>`);
    // A session that follows its instructions already has the note in its system prompt.
    expect(turnPrompt({ ...request, instructionsChanged: false }, turnInstructions("Be brief.", false, true))).toBe(
      "hi",
    );
  });
});
