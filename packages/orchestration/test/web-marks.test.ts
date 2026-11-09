import { AgentId, Attempt, AttemptId, TaskId, type WebReadMark } from "@hobbots/domain";
import { describe, expect, it } from "vitest";
import { markOfSession } from "../src/web-marks.ts";

const attempt = (number: number, sessionId: string | null, readWeb: WebReadMark | null) =>
  new Attempt({
    id: AttemptId.make(`attempt-${number}`),
    taskId: TaskId.make("task"),
    number,
    agentId: AgentId.make("pip"),
    runtime: "claude-code",
    sessionId,
    configVersion: 1,
    policyVersion: null,
    state: "completed",
    outcome: null,
    startedAt: `2026-11-09T10:0${number}:00.000Z`,
    endedAt: null,
    readWeb,
  });

describe("the read-the-web mark a resumed session holds", () => {
  // covers ADR 036 (The read-the-web mark)
  it("[TC-PE-1268-09] names what the session's latest Attempt read, since its first read the web, and ignores other sessions", () => {
    const pageA = { since: "2026-11-09T10:01:30.000Z", source: "https://a.test/page" };
    const pageB = { since: "2026-11-09T10:03:30.000Z", source: "https://b.test/page" };
    const elsewhere = { since: "2026-11-09T09:00:00.000Z", source: "https://c.test/page" };
    // Listed out of order, as nothing promises the order a tree reads its Attempts in.
    const attempts = [
      attempt(3, "session-1", pageB),
      attempt(1, "session-1", pageA),
      attempt(2, "session-1", null),
      attempt(4, "session-2", elsewhere),
    ];
    expect(markOfSession(attempts, "session-1")).toEqual({ since: pageA.since, source: pageB.source });
    expect(markOfSession(attempts, "session-2")).toEqual(elsewhere);
    expect(markOfSession([attempt(1, "session-1", null)], "session-1")).toBeNull();
    expect(markOfSession(attempts, "session-3")).toBeNull();
  });
});
