import type { DiagnosticsReport } from "@hobbots/api";
import {
  AgentId,
  AttemptId,
  BackpackBlocker,
  type BackpackItem,
  BackpackItemId,
  QuestId,
  RuntimeHealth,
  TaskId,
  ThreadId,
} from "@hobbots/domain";
import { describe, expect, it } from "vitest";
import {
  allowlistedReport,
  holdsSecret,
  leakedField,
  NO_PROGRESS_AFTER_MS,
  placesHidden,
  type ReportInput,
  redactedReport,
  stalledWork,
  titleOf,
} from "../src/diagnostics.ts";
import { makeRedactor } from "../src/secrets.ts";

const now = "2026-11-02T12:00:00.000Z";
const minutesAgo = (minutes: number) => new Date(Date.parse(now) - minutes * 60_000).toISOString();
const ADA = AgentId.make("ada");

/** An item as stalled work reads it; its payload plays no part. */
const backpackItem = (id: string, overrides: Partial<BackpackItem> = {}): BackpackItem =>
  ({
    id: BackpackItemId.make(id),
    recipientId: ADA,
    kind: "task",
    actionable: true,
    priority: 1,
    state: "pending",
    taskId: TaskId.make("build"),
    questId: QuestId.make("q1"),
    attemptId: null,
    threadId: ThreadId.make("t1"),
    dedupeKey: id,
    payload: null as never,
    notBefore: null,
    claim: null,
    fencingToken: 0,
    deliveries: [],
    disposition: null,
    error: null,
    blockers: [],
    createdAt: minutesAgo(60),
    updatedAt: minutesAgo(60),
    revision: 1,
    ...overrides,
  }) as BackpackItem;

describe("stalled work", () => {
  it("finds expired claims, items that used every try and running Attempts that went quiet", () => {
    const expired = backpackItem("expired", {
      state: "delivered",
      claim: { owner: "hub", token: 1, leaseExpiresAt: minutesAgo(2) },
    });
    const held = backpackItem("held", {
      state: "delivered",
      claim: { owner: "hub", token: 1, leaseExpiresAt: minutesAgo(-2) },
    });
    const blocker = (reason: "retries-exhausted" | "recipient-retired") =>
      new BackpackBlocker({
        number: 1,
        reason,
        nextAction: "retry",
        diagnostic: null,
        lastEnd: null,
        afterDeliveries: 3,
        raisedAt: minutesAgo(30),
        decision: null,
        decidedAt: null,
      });
    const exhausted = backpackItem("exhausted", { state: "failed", blockers: [blocker("retries-exhausted")] });
    const retired = backpackItem("retired", { state: "failed", blockers: [blocker("recipient-retired")] });
    const live = (id: string, startedAt: string, lastProgress: string | undefined) => ({
      attemptId: AttemptId.make(id),
      taskId: TaskId.make("build"),
      agentId: ADA,
      state: "running" as const,
      startedAt,
      lastProgress,
    });
    const quietMinutes = NO_PROGRESS_AFTER_MS / 60_000;

    const stalled = stalledWork({
      open: [expired, held],
      blocked: [exhausted, retired],
      live: [
        live("quiet", minutesAgo(90), minutesAgo(quietMinutes + 1)),
        live("busy", minutesAgo(90), minutesAgo(1)),
        live("new", minutesAgo(1), undefined),
        live("never", minutesAgo(quietMinutes + 5), undefined),
      ],
      questOf: (taskId) => (taskId === "build" ? QuestId.make("q1") : null),
      now,
    });

    expect(stalled.map((each) => [each.kind, each.itemId ?? each.attemptId, each.since])).toEqual([
      ["triesExhausted", "exhausted", minutesAgo(30)],
      ["noProgress", "never", minutesAgo(quietMinutes + 5)],
      ["noProgress", "quiet", minutesAgo(quietMinutes + 1)],
      ["claimExpired", "expired", minutesAgo(2)],
    ]);
    expect(stalled.every((each) => each.questId === "q1")).toBe(true);
  });
});

describe("report", () => {
  const input: ReportInput = {
    createdAt: now,
    hub: {
      version: "1.2.3",
      schemaVersion: 37,
      storage: "sqlite",
      os: "darwin",
      arch: "arm64",
      electron: null,
      node: "26.13.0",
    },
    runtimes: [
      new RuntimeHealth({
        runtime: "claude-code",
        availability: "ready",
        billing: "subscription (me@example.com)",
        version: "2.1.0",
        detail: "Signed in as me@example.com",
        checkedAt: now,
        enforcement: {
          toolInterception: { status: "verified", evidence: "" },
          processSandbox: { status: "verified", evidence: "" },
          hubTools: { status: "verified", evidence: "" },
          toolEvents: { status: "verified", evidence: "" },
          toolInterruption: { status: "verified", evidence: "" },
          webSearch: { status: "verified", evidence: "" },
        },
      }),
    ],
    memory: {
      state: "running",
      offReason: null,
      version: "3.4.2",
      restarts: 1,
      lastExit: { code: 3, at: "2026-10-30T11:58:00.000Z" },
      runningSince: "2026-10-30T11:58:01.000Z",
    },
    workHeld: false,
    stalled: [],
    recovery: [],
    skills: [],
    trace: null,
    includeTitles: false,
  };

  // covers ADR 029 (Backups, exports and Diagnostics), #1064
  it("[TC-OP-120] keeps each hob's skill names and revisions, and drops anything else a skill carries", () => {
    const revision = "e".repeat(64) as never;
    const report = allowlistedReport({
      ...input,
      skills: [
        {
          agentId: ADA,
          runtime: "codex",
          skills: [
            {
              name: "release-steps",
              number: 4,
              revision,
              scope: "Project",
              set: "agent-engineering",
              description: "How we release",
              instructions: "Tag, then push.",
            } as ReportInput["skills"][number]["skills"][number],
          ],
          clashes: [],
        },
      ],
    });
    expect(report.skills).toEqual([
      {
        agentId: ADA,
        runtime: "codex",
        skills: [{ name: "release-steps", number: 4, revision, scope: "Project", set: "agent-engineering" }],
        clashes: [],
      },
    ]);
  });

  it("holds only what its schema names, so account details and new fields never reach it", () => {
    const report = allowlistedReport({
      ...input,
      // A field the schema does not name, as a later change might add, is dropped.
      stalled: [
        {
          kind: "noProgress",
          agentId: ADA,
          taskId: null,
          questId: null,
          attemptId: null,
          itemId: null,
          since: now,
          brief: "A secret plan",
        } as ReportInput["stalled"][number],
      ],
    });
    expect(report.runtimes).toEqual([
      { runtime: "claude-code", version: "2.1.0", availability: "ready", signedIn: true },
    ]);
    // The memory engine's health names no path, port or key, so it goes in as it is.
    expect(report.memory).toEqual(input.memory);
    expect(JSON.stringify(report)).not.toContain("example.com");
    expect(JSON.stringify(report)).not.toContain("A secret plan");
  });

  it("redacts every string and names paths without saying where", () => {
    const hide = placesHidden({ home: "/Users/me", folders: ["/Users/me/shop", "/Volumes/work/"] });
    expect(hide("/Users/me/shop/sale.html, /Users/me/shopping and /Volumes/work")).toBe(
      "folder 1/sale.html, ~/shopping and folder 2",
    );
    const report = allowlistedReport({
      ...input,
      recovery: [
        {
          step: "endAttempt",
          tag: "SqlError",
          message: "locked /Users/me/shop/db with sk-ant-0123456789abcdefghijklmnop",
          taskId: null,
          attemptId: null,
          at: now,
        },
      ],
    });
    const redacted = redactedReport(report, makeRedactor(), { home: "/Users/me", folders: ["/Users/me/shop"] });
    expect(redacted.recovery[0]?.message).toBe("locked folder 1/db with [redacted: Anthropic key]");
  });

  it("finds the field that still holds a credential, and none in a redacted report", () => {
    const redactor = makeRedactor([{ value: "known-value-0123456789", kind: "HUB_TOKEN" }]);
    const report = allowlistedReport(input) as DiagnosticsReport;
    const leaky = {
      ...report,
      recovery: [
        {
          step: "endStep",
          tag: "Error",
          message: "it was known-value-0123456789",
          taskId: null,
          attemptId: null,
          at: now,
        },
      ],
    };
    expect(leakedField(leaky, holdsSecret(redactor))).toBe("recovery.0.message");
    expect(leakedField(redactedReport(leaky, redactor, { home: "/nowhere", folders: [] }), holdsSecret(redactor))).toBe(
      null,
    );
    // A value only the final check knows is refused even though the redactor let it through.
    const late = [{ value: "late-value-0123456789", kind: "window key" }];
    const caught = { ...report, hub: { ...report.hub, version: "late-value-0123456789" } };
    expect(leakedField(caught, holdsSecret(redactor, late))).toBe("hub.version");
  });

  it("titles a brief by its first line, cut short", () => {
    expect(titleOf("  Draft the copy \nmore")).toBe("Draft the copy");
    expect(titleOf("x".repeat(200))).toHaveLength(120);
  });
});
