import type { ReplyStep } from "@hobbots/domain";
import { describe, expect, it } from "vitest";
import { minutesBetween, minutesSince, replyRun, replyRuns, replyWait, shortCommand } from "./reply-wait.ts";

const call = { tool: "Bash", operation: "run-commands", targets: ["/work"] } as const;
const step = (id: string, label: string, fields: Partial<ReplyStep> = {}): ReplyStep => ({
  id,
  kind: "tool",
  label,
  state: "running",
  call,
  startedAt: "2026-11-07T10:00:00.000Z",
  ...fields,
});

describe("replyWait (#1056)", () => {
  it("names the commands a reply in progress waits on, and when the first started", () => {
    const wait = replyWait({
      status: "streaming",
      steps: [
        step("t1", "Running pnpm test", { state: "done" }),
        step("t2", "Running pnpm build", { waitedOn: true, startedAt: "2026-11-07T10:05:00.000Z" }),
        step("t3", "Running pnpm dev", { waitedOn: true }),
      ],
    });
    expect(wait).toEqual({ commands: ["pnpm build", "pnpm dev"], since: "2026-11-07T10:00:00.000Z" });
  });

  it("is null while the hob is at work, and once the reply has ended", () => {
    expect(replyWait({ status: "streaming", steps: [step("t1", "Running pnpm dev")] })).toBeNull();
    expect(replyWait({ status: "complete", steps: [step("t1", "Running pnpm dev", { waitedOn: true })] })).toBeNull();
    expect(replyWait(undefined)).toBeNull();
    // Stopping keeps saying what it waits on, so the hint can say what is stopped.
    expect(replyWait({ status: "stopping", steps: [step("t1", "Running pnpm dev", { waitedOn: true })] })).toEqual({
      commands: ["pnpm dev"],
      since: "2026-11-07T10:00:00.000Z",
    });
  });

  it("cuts a long command for the hint", () => {
    expect(shortCommand("pnpm --filter @hobbots/web exec vite build --watch")).toBe("pnpm --filter @hobbots/web exec…");
    expect(shortCommand("pnpm dev")).toBe("pnpm dev");
  });

  it("counts whole minutes", () => {
    expect(minutesSince("2026-11-07T10:00:00.000Z", new Date("2026-11-07T10:14:59.000Z"))).toBe(14);
    expect(minutesSince(null, new Date())).toBe(0);
    expect(minutesBetween("2026-11-07T10:00:00.000Z", "2026-11-07T10:03:10.000Z")).toBe(3);
    expect(minutesBetween(undefined, "2026-11-07T10:03:10.000Z")).toBeNull();
  });
});

describe("replyRun (#1423)", () => {
  const waited = [step("t1", "Running pnpm dev", { waitedOn: true })];
  const wait = { commands: ["pnpm dev"], since: "2026-11-07T10:00:00.000Z" };

  it("is idle with no reply in progress, whatever Stop asked", () => {
    expect(replyRun(undefined, true)).toEqual({ mode: "idle" });
    expect(replyRun({ status: "complete", steps: waited }, true)).toEqual({ mode: "idle" });
    expect(replyRuns(replyRun(undefined, false))).toBe(false);
  });

  it("is replying while the hob is at work, and waiting once only commands keep the reply open", () => {
    expect(replyRun({ status: "streaming", steps: [step("t1", "Running pnpm dev")] }, false)).toEqual({
      mode: "replying",
    });
    expect(replyRun({ status: "streaming", steps: waited }, false)).toEqual({ mode: "waiting", wait });
  });

  it("is stopping from Stop until the reply ends, keeping what it waits on", () => {
    expect(replyRun({ status: "streaming", steps: [] }, true)).toEqual({ mode: "stopping", wait: null });
    expect(replyRun({ status: "stopping", steps: waited }, false)).toEqual({ mode: "stopping", wait });
    expect(replyRuns(replyRun({ status: "stopping", steps: [] }, false))).toBe(true);
  });
});
