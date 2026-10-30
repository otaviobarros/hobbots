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
import { Duration, Effect, Exit, Layer, Stream } from "effect";
import { TestClock } from "effect/testing";
import { afterAll, describe, expect, it } from "vitest";
import {
  brainOptions,
  claudeCandidates,
  expiringCache,
  fallbackModels,
  findClaudeCode,
  isAtLeast,
  makeClaudeCode,
  modelListMaxAge,
  parseVersion,
  runtimePath,
  toRuntimeModels,
} from "../src/claude-code.ts";

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
        adapter.sendPrompt({ prompt: "hi", sessionId: null, instructions: "", model: null, effort: null }),
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
