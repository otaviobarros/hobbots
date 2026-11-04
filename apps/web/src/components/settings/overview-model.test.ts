import type { RemoteAccessStatus } from "@hobbots/domain";
import { RuntimeHealth } from "@hobbots/domain";
import { describe, expect, it } from "vitest";
import { enforcementFixture } from "../../test/enforcement.ts";
import {
  type OverviewInput,
  type OverviewReads,
  overviewOf,
  overviewTitle,
  pendingCards,
  waitingOn,
} from "./overview-model.ts";
import { findSettings } from "./sections.ts";

const health = (runtime: RuntimeHealth["runtime"], availability: RuntimeHealth["availability"]) =>
  new RuntimeHealth({
    runtime,
    availability,
    billing: null,
    version: "2.1.301",
    detail: null,
    checkedAt: "2026-11-04T12:00:00.000Z",
    enforcement: enforcementFixture(),
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

const input = (overrides: Partial<OverviewInput> = {}): OverviewInput => ({
  runtimes: [health("claude-code", "ready")],
  connected: ["claude-code"],
  preset: "balanced",
  github: { _tag: "Disconnected", problem: null, cannotConnect: null },
  remote: remote({ enabled: false, problem: "off", listening: [] }),
  otherDevices: 0,
  backup: { _tag: "Idle" },
  theme: "lamplight-dusk",
  now: new Date("2026-11-04T12:00:00.000Z"),
  ...overrides,
});

const card = (overview: ReturnType<typeof overviewOf>, id: string) => overview.cards.find((c) => c.id === id);

describe("the Settings overview", () => {
  it("shows one card per area, in the design's order, with nothing to fix", () => {
    const overview = overviewOf(input());
    expect(overview.cards.map((c) => c.id)).toEqual(["ai", "safety", "github", "devices", "backups", "appearance"]);
    expect(overview.problems).toEqual([]);
    expect(overview.flagged.size).toBe(0);
    expect(card(overview, "ai")).toMatchObject({ tone: "ok", state: "Ready", section: "connections" });
    expect(card(overview, "safety")).toMatchObject({ state: "Balanced", section: "safety" });
    expect(card(overview, "appearance")).toMatchObject({ state: "Lamplight · Dark", section: "app" });
    expect(overviewTitle(0).title).toBe("Everything is working");
  });

  it("puts a connected provider that cannot think first, and marks its section", () => {
    const overview = overviewOf(
      input({
        runtimes: [health("claude-code", "signedOut"), health("codex", "unavailable")],
        connected: ["claude-code"],
      }),
    );
    // Codex is not connected, so it is not something to fix.
    expect(overview.problems).toEqual([{ kind: "provider", runtime: "claude-code", title: "Claude: Signed out" }]);
    expect(card(overview, "ai")).toMatchObject({ tone: "broken", state: "Signed out" });
    expect([...overview.flagged]).toEqual(["connections"]);
    expect(overviewTitle(overview.problems.length).title).toBe("One thing needs fixing");
  });

  it("says when remote access is on but the hub cannot be reached", () => {
    const overview = overviewOf(input({ remote: remote({ problem: "tailscale", listening: [] }) }));
    expect(overview.problems.map((p) => p.kind)).toEqual(["devices"]);
    expect([...overview.flagged]).toEqual(["devices"]);
  });

  it("counts the allowed devices, and treats paused and off as choices, not faults", () => {
    expect(card(overviewOf(input({ remote: remote(), otherDevices: 2 })), "devices")?.state).toBe("On · 2 allowed");
    const paused = overviewOf(input({ remote: remote({ paused: true, problem: "paused", listening: [] }) }));
    expect(card(paused, "devices")?.tone).toBe("busy");
    expect(paused.problems).toEqual([]);
  });

  it("reports a failed backup as something to fix, with the hub's reason", () => {
    const overview = overviewOf(
      input({ backup: { _tag: "Failed", reason: "The folder is full.", finishedAt: "2026-11-04T11:00:00.000Z" } }),
    );
    expect(overview.problems).toEqual([
      { kind: "backup", title: "The last backup failed", body: "The folder is full." },
    ]);
    expect(overviewTitle(overview.problems.length).line).toBe("Fix it below. The rest is fine.");
  });

  it("names the look and mode of every theme", () => {
    expect(card(overviewOf(input({ theme: "workshop-daylight" })), "appearance")?.state).toBe("Workshop · Light");
    expect(card(overviewOf(input({ theme: "workshop-night" })), "appearance")?.state).toBe("Workshop · Dark");
    expect(card(overviewOf(input({ theme: "lamplight-paper" })), "appearance")?.state).toBe("Lamplight · Light");
    expect(card(overviewOf(input({ theme: "lamplight-auto" })), "appearance")?.state).toBe("Lamplight · Automatic");
  });

  it("shows the hub's GitHub account and a connected desktop's hub", () => {
    const github = overviewOf(
      input({
        github: { _tag: "Connected", account: { login: "octo", via: "app" } as never },
        remote: null,
      }),
    );
    expect(card(github, "github")).toMatchObject({ tone: "ok", hint: "Hobs act on GitHub through octo." });
    expect(card(github, "devices")?.state).toBe("Uses another computer");
  });
});

describe("Find a setting", () => {
  it("matches everyday and technical names, with each hit's section", () => {
    expect(findSettings("tailscale").map((hit) => hit.section)).toEqual(["devices"]);
    expect(findSettings("permissions").map((hit) => hit.label)).toEqual(["How careful hobs are"]);
    expect(findSettings("BACKUP").map((hit) => hit.section)).toContain("data");
    expect(findSettings("charms").map((hit) => hit.label)).toEqual(["GitHub"]);
  });

  it("finds nothing for an empty query", () => expect(findSettings("  ")).toEqual([]));
});

describe("the overview while it loads", () => {
  const settled: OverviewReads = {
    runtimes: false,
    setup: false,
    github: false,
    remote: false,
    devices: false,
    backup: false,
    remoteOn: false,
  };

  it("holds a block for each card whose read has not landed, and none once all have", () => {
    expect([...pendingCards(settled)]).toEqual([]);
    expect([...pendingCards({ ...settled, setup: true })]).toEqual(["ai", "safety"]);
    expect([...pendingCards({ ...settled, runtimes: true, github: true, backup: true })]).toEqual([
      "ai",
      "github",
      "backups",
    ]);
  });

  it("waits on the device count only while remote access is on", () => {
    expect([...pendingCards({ ...settled, devices: true })]).toEqual([]);
    expect([...pendingCards({ ...settled, devices: true, remoteOn: true })]).toEqual(["devices"]);
    expect([...pendingCards({ ...settled, remote: true })]).toEqual(["devices"]);
  });

  it("names the providers first, then GitHub, then Tailscale, and nothing for reads from the hub", () => {
    expect(waitingOn({ ...settled, runtimes: true, github: true, remote: true })).toBe("providers");
    expect(waitingOn({ ...settled, github: true, remote: true })).toBe("github");
    expect(waitingOn({ ...settled, remote: true })).toBe("tailscale");
    expect(waitingOn({ ...settled, setup: true, backup: true, devices: true })).toBeNull();
  });
});
