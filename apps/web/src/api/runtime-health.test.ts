import { RuntimeHealth } from "@hobbots/domain";
import { describe, expect, it } from "vitest";
import { enforcementFixture } from "../test/enforcement.ts";
import { canContinueSetup, runtimeProblem, runtimeStaleTime } from "./runtime-health.ts";

const health = (availability: RuntimeHealth["availability"], version: string | null) =>
  new RuntimeHealth({
    runtime: "claude-code",
    availability,
    billing: null,
    version,
    detail: null,
    checkedAt: "2026-10-28T12:00:00.000Z",
    enforcement: enforcementFixture(),
  });

describe("runtimeProblem", () => {
  it("is not found without a version", () => expect(runtimeProblem(health("unavailable", null))).toBe("notFound"));
  it("did not start with a version", () => expect(runtimeProblem(health("unavailable", "2.1.301"))).toBe("notStarted"));
  it("asks for a sign-in when Claude Code is signed out", () =>
    expect(runtimeProblem(health("signedOut", "2.1.301"))).toBe("signedOut"));
  it("reports an old version", () => expect(runtimeProblem(health("outdated", "2.1.200"))).toBe("outdated"));
  it("has nothing to fix when ready or unknown", () => {
    expect(runtimeProblem(health("ready", "2.1.301"))).toBeNull();
    expect(runtimeProblem(undefined)).toBeNull();
  });
});

describe("runtimeStaleTime", () => {
  it("keeps a ready provider for a minute", () => expect(runtimeStaleTime([health("ready", "2.1.301")])).toBe(60_000));
  it("checks a provider that needs fixing every time", () => {
    expect(runtimeStaleTime([health("unavailable", null)])).toBe(0);
    expect(runtimeStaleTime([health("outdated", "2.1.200")])).toBe(0);
    expect(runtimeStaleTime([health("signedOut", "2.1.301")])).toBe(0);
    expect(runtimeStaleTime(undefined)).toBe(0);
  });
});

describe("canContinueSetup", () => {
  it("continues with a ready provider the user connected", () =>
    expect(canContinueSetup([health("ready", "2.1.301")], ["claude-code"])).toBe(true));
  it("waits until the user connects a ready provider", () => {
    expect(canContinueSetup([health("ready", "2.1.301")], [])).toBe(false);
    expect(canContinueSetup([health("ready", "2.1.301")], undefined)).toBe(false);
  });
  it("waits while the connected provider is not ready or none is known yet", () => {
    for (const availability of ["outdated", "signedOut", "unavailable", "unverified"] as const) {
      expect(canContinueSetup([health(availability, "2.1.301")], ["claude-code"])).toBe(false);
    }
    expect(canContinueSetup([], ["claude-code"])).toBe(false);
    expect(canContinueSetup(undefined, ["claude-code"])).toBe(false);
  });
});
