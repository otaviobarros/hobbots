import { chmodSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { Effect, Exit, Stream } from "effect";
import { afterAll, describe, expect, it } from "vitest";
import {
  claudeCandidates,
  findClaudeCode,
  isAtLeast,
  makeClaudeCode,
  parseVersion,
  runtimePath,
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
      Stream.runDrain(adapter.sendPrompt({ prompt: "hi", sessionId: null, instructions: "", model: null })),
    );

  it("reports an old release as outdated and refuses chat turns with update guidance", async () => {
    const adapter = await Effect.runPromise(adapterFor('#!/bin/sh\necho "2.1.200 (Claude Code)"\n'));
    const health = await Effect.runPromise(adapter.health);
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

  it("reports a binary that prints no version as unavailable", async () => {
    const adapter = await Effect.runPromise(adapterFor("#!/bin/sh\necho nope\n"));
    const health = await Effect.runPromise(adapter.health);
    expect(health.availability).toBe("unavailable");
    expect(health.version).toBeNull();
    const refused = await turn(adapter);
    expect(Exit.isFailure(refused) && String(refused.cause)).toContain("could not be started");
  });
});
