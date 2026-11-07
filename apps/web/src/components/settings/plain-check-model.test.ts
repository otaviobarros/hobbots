import type { MemoryEngineHealth, RemoteAccessStatus } from "@hobbots/domain";
import { RuntimeHealth } from "@hobbots/domain";
import { describe, expect, it } from "vitest";
import { enforcementFixture } from "../../test/enforcement.ts";
import { type CheckInput, checkLines } from "./plain-check-model.ts";

const health = (
  runtime: RuntimeHealth["runtime"],
  availability: RuntimeHealth["availability"],
  sandbox: "verified" | "unverified" = "verified",
) =>
  new RuntimeHealth({
    runtime,
    availability,
    billing: "subscription (max)",
    version: "2.1.301",
    detail: null,
    checkedAt: "2026-11-04T12:00:00.000Z",
    enforcement: enforcementFixture(sandbox),
  });

const remote = (overrides: Partial<RemoteAccessStatus> = {}): RemoteAccessStatus => ({
  enabled: true,
  paused: false,
  port: 4317,
  tailscale: null,
  listening: ["100.64.0.1"],
  problem: null,
  detail: null,
  https: { enabled: false, port: 4318, listening: false, forwarding: null, detail: null },
  ...overrides,
});

const engine = (overrides: Partial<MemoryEngineHealth> = {}): MemoryEngineHealth => ({
  state: "running",
  offReason: null,
  version: "3.4.2",
  restarts: 0,
  lastExit: null,
  runningSince: "2026-11-04T12:00:00.000Z",
  ...overrides,
});

const input = (overrides: Partial<CheckInput> = {}): CheckInput => ({
  runtimes: [health("claude-code", "ready")],
  memory: engine(),
  connected: ["claude-code"],
  folders: 3,
  github: { _tag: "Disconnected", problem: null, cannotConnect: null },
  remote: remote({ enabled: false, problem: "off", listening: [] }),
  stuck: 0,
  ...overrides,
});

const line = (lines: ReturnType<typeof checkLines>, key: string) => lines.find((each) => each.key === key);

describe("the plain check", () => {
  it("says each part works in plain words", () => {
    const lines = checkLines(input());
    expect(lines.map((each) => each.key)).toEqual([
      "claude-code",
      "sandbox",
      "memory",
      "folders",
      "github",
      "remote",
      "stuck",
    ]);
    expect(line(lines, "claude-code")).toMatchObject({ tone: "ok", text: "Claude answers" });
    expect(line(lines, "memory")).toMatchObject({ tone: "ok", text: "Memory is running" });
    expect(line(lines, "sandbox")).toMatchObject({ tone: "ok" });
    expect(line(lines, "folders")).toMatchObject({ tone: "ok", text: "Your 3 folders open" });
    expect(line(lines, "github")).toMatchObject({ tone: "off", text: "GitHub is not connected (optional)" });
    expect(line(lines, "remote")).toMatchObject({ tone: "off" });
    expect(line(lines, "stuck")).toMatchObject({ tone: "ok", text: "Nothing is stuck" });
  });

  it("counts stuck work as the Inbox does, and points to the Inbox", () => {
    expect(line(checkLines(input({ stuck: 2 })), "stuck")).toMatchObject({
      tone: "broken",
      text: "2 things are stuck. Retry or dismiss them in the Inbox.",
      inbox: true,
    });
    expect(line(checkLines(input({ stuck: 1 })), "stuck")?.text).toBe(
      "1 thing is stuck. Retry or dismiss it in the Inbox.",
    );
  });

  it("names a provider that cannot think and a sandbox that is not verified", () => {
    const lines = checkLines(input({ runtimes: [health("claude-code", "signedOut", "unverified")] }));
    expect(line(lines, "claude-code")).toMatchObject({
      tone: "broken",
      text: "Claude: Signed out. Connections says how to fix it.",
    });
    expect(line(lines, "sandbox")).toMatchObject({ tone: "warn" });
  });

  it("says when no AI is connected, no folder is set or remote access cannot be reached", () => {
    const lines = checkLines(input({ connected: [], folders: 0, remote: remote({ problem: "cannotListen" }) }));
    expect(line(lines, "ai")).toMatchObject({ tone: "broken" });
    expect(line(lines, "folders")).toMatchObject({ tone: "off" });
    expect(line(lines, "remote")).toMatchObject({ tone: "broken" });
  });

  it("says when memory is off by choice, starting again, or cannot start in this copy (#1088)", () => {
    const memory = (health: MemoryEngineHealth) => line(checkLines(input({ memory: health })), "memory");
    expect(memory(engine({ state: "off", offReason: "disabled" }))).toMatchObject({
      tone: "off",
      text: "Memory is turned off (optional)",
    });
    expect(memory(engine({ state: "restarting" }))).toMatchObject({ tone: "warn" });
    expect(memory(engine({ state: "starting" }))).toMatchObject({ tone: "warn", text: "Memory is starting" });
    expect(memory(engine({ state: "off", offReason: "missing" }))).toMatchObject({ tone: "broken" });
    expect(memory(engine({ state: "off", offReason: "checksum" }))?.text).toContain("Reinstall Hobbots");
    // A read that failed says so, and asks to check again, rather than leave the line out.
    expect(line(checkLines(input({ memory: "failed" })), "memory")).toMatchObject({
      tone: "warn",
      text: "Hobbots could not check memory. Check again in a moment.",
    });
    // A hub that runs no engine has no line for it.
    expect(line(checkLines(input({ memory: null })), "memory")).toBeUndefined();
  });

  it("leaves remote access to the hub on a connected desktop, and waits for what is still loading", () => {
    const lines = checkLines(input({ remote: null, stuck: undefined, folders: undefined, memory: undefined }));
    expect(lines.map((each) => each.key)).toEqual(["claude-code", "sandbox", "github"]);
  });
});

describe("the plain check while it runs", () => {
  it("names each line and the read it comes from, so a line can say it is checking", () => {
    const lines = checkLines(input());
    expect(lines.map((each) => [each.key, each.name, each.source])).toEqual([
      ["claude-code", "Claude", "runtimes"],
      ["sandbox", "Sandbox", "runtimes"],
      ["memory", "Memory", "memory"],
      ["folders", "Folders", "setup"],
      ["github", "GitHub", "github"],
      ["remote", "Other devices", "remote"],
      ["stuck", "Stuck work", "blockers"],
    ]);
    expect(line(checkLines(input({ connected: [] })), "ai")).toMatchObject({ name: "AI", source: "setup" });
  });
});
