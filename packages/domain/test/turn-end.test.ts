import { describe, expect, it } from "vitest";
import {
  AgentId,
  AttemptTransitions,
  BackpackItem,
  BackpackItemId,
  CANCELLED_ATTEMPT,
  type LedgerEntry,
  Milestone,
  MilestoneId,
  Task,
  TaskId,
  type TaskMove,
  type TaskState,
  TaskWait,
  type TurnEnding,
  type TurnRunner,
  turnEnded,
} from "../src/index.ts";

// The one turn-end decision (#669, #674): every ending against every Task state, for each runner.

const at = "2026-11-03T00:00:00.000Z";
const PIP = AgentId.make("pip");

const task = (state: TaskState) =>
  new Task({
    id: TaskId.make("review"),
    ownerId: PIP,
    parentId: TaskId.make("top"),
    rootId: TaskId.make("top"),
    threadId: null,
    brief: "Review the project",
    state,
    dependsOn: [],
    result: null,
    currentAttemptId: null,
    createdAt: at,
    updatedAt: at,
    revision: 1,
  });

const ENDINGS_END = { stopped: { _tag: "Stopped", reason: "Stopped by Hobbots" } } as const;

const ENDINGS: Record<"replied" | "failed" | "stopped", TurnEnding> = {
  replied: { _tag: "Replied", text: "Reviewed it" },
  failed: { _tag: "Failed", reason: "The runtime broke" },
  stopped: { _tag: "Stopped", reason: "Stopped by Hobbots" },
};

/** A move as a short word: `stay`, `→failed`, `back`, or `complete|<what the Task does when that is refused>`. */
const shown = (move: TaskMove): string =>
  move._tag === "Stay"
    ? "stay"
    : move._tag === "Move"
      ? `→${move.to}`
      : move._tag === "SendBack"
        ? "back"
        : `complete|${shown(move.otherwise)}`;

const STATES: ReadonlyArray<TaskState> = [
  "queued",
  "active",
  "waiting",
  "blocked",
  "cancelling",
  "completed",
  "failed",
  "cancelled",
];

/** The Attempt's end by Task state, for a reply, a failure and a stop, whatever ran it. */
const ATTEMPTS: Record<TaskState, readonly [string, string, string]> = {
  queued: ["completed", "failed", "interrupted"],
  active: ["completed", "failed", "interrupted"],
  waiting: ["completed", "failed", "interrupted"],
  blocked: ["completed", "failed", "interrupted"],
  cancelling: ["cancelled", "failed", "cancelled"],
  completed: ["completed", "failed", "interrupted"],
  failed: ["completed", "failed", "interrupted"],
  cancelled: ["cancelled", "failed", "cancelled"],
};

/** What the Task does by runner and Task state, for a reply, a failure and a stop, with nothing open. */
const MOVES: Record<TurnRunner, Record<TaskState, readonly [string, string, string]>> = {
  step: {
    queued: ["complete|→failed", "→failed", "→failed"],
    active: ["complete|→failed", "→failed", "→failed"],
    waiting: ["complete|→failed", "→failed", "→failed"],
    blocked: ["complete|→failed", "→failed", "→failed"],
    cancelling: ["→cancelled", "→cancelled", "→cancelled"],
    completed: ["stay", "stay", "stay"],
    failed: ["stay", "stay", "stay"],
    cancelled: ["stay", "stay", "stay"],
  },
  member: {
    queued: ["back", "stay", "stay"],
    active: ["back", "stay", "→waiting"],
    waiting: ["back", "stay", "stay"],
    blocked: ["back", "stay", "stay"],
    cancelling: ["→cancelled", "→cancelled", "→cancelled"],
    completed: ["stay", "stay", "stay"],
    failed: ["stay", "stay", "stay"],
    cancelled: ["stay", "stay", "stay"],
  },
  root: {
    queued: ["stay", "stay", "stay"],
    active: ["stay", "stay", "stay"],
    waiting: ["stay", "stay", "stay"],
    blocked: ["stay", "stay", "stay"],
    cancelling: ["→cancelled", "→cancelled", "→cancelled"],
    completed: ["stay", "stay", "stay"],
    failed: ["stay", "stay", "stay"],
    cancelled: ["stay", "stay", "stay"],
  },
};

const decide = (runner: TurnRunner, state: TaskState, ending: TurnEnding, ledger: ReadonlyArray<LedgerEntry> = []) =>
  turnEnded({ runner, task: task(state), ending, ledger, carried: new Set() });

const milestone = (title: string): LedgerEntry => ({
  _tag: "Milestone",
  milestone: new Milestone({
    id: MilestoneId.make(title),
    taskId: TaskId.make("review"),
    title,
    position: 0,
    reachedAt: null,
    createdAt: at,
  }),
});

const deadline = (id: string): LedgerEntry => ({
  _tag: "Item",
  item: new BackpackItem({
    id: BackpackItemId.make(id),
    recipientId: PIP,
    kind: "deadline",
    actionable: true,
    priority: 1,
    state: "pending",
    taskId: TaskId.make("review"),
    questId: null,
    attemptId: null,
    threadId: null,
    dedupeKey: id,
    payload: { _tag: "deadline", taskId: TaskId.make("review"), dueAt: at },
    notBefore: null,
    claim: null,
    fencingToken: 0,
    deliveries: [],
    blockers: [],
    disposition: null,
    error: null,
    createdAt: at,
    updatedAt: at,
    revision: 1,
  }),
});

const waitEntry: LedgerEntry = {
  _tag: "Wait",
  wait: new TaskWait({ taskId: TaskId.make("review"), on: [TaskId.make("lint")], mode: "all", createdAt: at }),
};

describe("turnEnded", () => {
  // covers EX-001, OR-006
  it("[TC-OR-455] decides the Attempt's end and the Task's move for every ending, Task state and runner", () => {
    for (const runner of ["step", "member", "root"] as const) {
      for (const state of STATES) {
        const decided = (["replied", "failed", "stopped"] as const).map((name) => decide(runner, state, ENDINGS[name]));
        expect([runner, state, decided.map((each) => each.attempt.state)]).toEqual([runner, state, ATTEMPTS[state]]);
        expect([runner, state, decided.map((each) => shown(each.task))]).toEqual([runner, state, MOVES[runner][state]]);
      }
    }
    // A step that replied after reporting a finding or blocker is held for its owner (#667), unless its cancel was asked for.
    const held = (state: TaskState, ending: TurnEnding, lastReport: "finding" | "blocker" | "milestone") =>
      shown(turnEnded({ runner: "step", task: task(state), ending, ledger: [], carried: new Set(), lastReport }).task);
    expect([
      held("active", ENDINGS.replied, "finding"),
      held("active", ENDINGS.replied, "blocker"),
      held("active", ENDINGS.replied, "milestone"),
      held("active", ENDINGS.failed, "finding"),
      held("cancelling", ENDINGS.replied, "finding"),
    ]).toEqual(["→blocked", "→blocked", "complete|→failed", "→failed", "→cancelled"]);
  });

  // covers EX-001, OR-006
  it("[TC-OR-456] says why an Attempt ended: a cancel names it, a failure and a stop keep their reason", () => {
    expect(decide("member", "cancelling", ENDINGS.replied).attempt).toEqual({
      state: "cancelled",
      outcome: CANCELLED_ATTEMPT,
    });
    expect(decide("step", "active", ENDINGS.replied).attempt).toEqual({
      state: "completed",
      outcome: "The step's session finished.",
    });
    expect(decide("member", "active", ENDINGS.replied).attempt.outcome).toBe("The turn finished.");
    expect(decide("root", "active", ENDINGS.replied).attempt.outcome).toBe("The turn finished.");
    expect(decide("member", "cancelling", ENDINGS.failed).attempt).toEqual({
      state: "failed",
      outcome: "The runtime broke",
    });
    expect(decide("step", "active", ENDINGS.stopped).attempt).toEqual({
      state: "interrupted",
      outcome: "Stopped by Hobbots",
    });
    // The record names who cancelled it, when it knows.
    expect(AttemptTransitions.end(task("cancelled"), ENDINGS_END.stopped, "Pip").outcome).toBe(
      "Pip cancelled this Task.",
    );
    expect(AttemptTransitions.end(task("cancelling"), ENDINGS_END.stopped, "You").outcome).toBe(
      "You cancelled this Task.",
    );
    // A stop Hobbots could not confirm stays unresolved, cancel or not.
    expect(AttemptTransitions.end(task("cancelling"), { _tag: "Unconfirmed", reason: "Not confirmed" }).state).toBe(
      "unresolved",
    );
    // A reply becomes the result, or says there was none.
    const empty = decide("step", "active", { _tag: "Replied", text: "  " }).task;
    expect(empty).toMatchObject({ _tag: "Complete", summary: "The step finished without a reply." });
  });

  // covers OR-004, IN-004
  it("[TC-OR-457] holds a member's Task open on what its ledger still has, and gives the root's waits back", () => {
    // Only its own milestones left: blocked, with a reason its lead can act on (#571).
    const short = decide("member", "active", ENDINGS.replied, [milestone("Reviewed")]);
    expect(shown(short.task)).toBe("→blocked");
    expect(short.task).toMatchObject({ reason: expect.stringContaining('"Reviewed"') });
    // Anything else open: it waits, and nothing is completed.
    expect(shown(decide("member", "active", ENDINGS.replied, [milestone("Reviewed"), deadline("n1")]).task)).toBe(
      "→waiting",
    );
    // What the turn carried settles with it, so it keeps nothing open.
    const carried = turnEnded({
      runner: "member",
      task: task("active"),
      ending: ENDINGS.replied,
      ledger: [deadline("n1")],
      carried: new Set(["n1"]),
    });
    expect(shown(carried.task)).toBe("back");
    // The root waits while its wait holds, or goes back to what it was before the turn.
    expect(shown(decide("root", "active", ENDINGS.replied, [waitEntry]).task)).toBe("→waiting");
    const was = (before: TaskState) =>
      shown(
        turnEnded({
          runner: "root",
          task: task("active"),
          ending: ENDINGS.failed,
          ledger: [],
          carried: new Set(),
          was: before,
        }).task,
      );
    expect([was("waiting"), was("blocked"), was("active")]).toEqual(["→waiting", "→blocked", "stay"]);
  });

  // covers OR-004, EX-002
  it("[TC-OR-640] keeps the root it was blocked on a stalled Quest active once a Task under it is open", () => {
    const child: LedgerEntry = { _tag: "Child", task: task("active") };
    const moved = (ledger: ReadonlyArray<LedgerEntry>) =>
      shown(
        turnEnded({
          runner: "root",
          task: task("active"),
          ending: ENDINGS.replied,
          ledger,
          carried: new Set(),
          was: "blocked",
        }).task,
      );
    // Its lead delegated again: a Task under it moves the Quest on, so it is not blocked (#1081).
    expect(moved([child])).toBe("stay");
    // A wait that holds still shows waiting, and nothing open gives the block back.
    expect(moved([child, waitEntry])).toBe("→waiting");
    expect(moved([])).toBe("→blocked");
  });

  // covers OR-004, EX-002
  it("[TC-OR-648] never shows a member's Task done on its reply alone: it sends the member back once, then blocks it", () => {
    const again = (state: TaskState, ending: TurnEnding, ledger: ReadonlyArray<LedgerEntry> = []) =>
      turnEnded({ runner: "member", task: task(state), ending, ledger, carried: new Set(), sentBack: true });
    const unfinished: TurnEnding = { _tag: "Replied", text: "  The Task is blocked and not complete.  " };
    // A reply with nothing open sends its member back, whatever it says (#1086).
    expect(shown(decide("member", "active", unfinished).task)).toBe("back");
    expect(decide("member", "active", unfinished).attempt.state).toBe("completed");
    // Sent back and replying again: blocked, with the reply as the reason its lead reads.
    const blocked = again("active", unfinished).task;
    expect(shown(blocked)).toBe("→blocked");
    expect(blocked).toMatchObject({
      reason: expect.stringContaining("last reply: The Task is blocked and not complete."),
    });
    expect(again("waiting", { _tag: "Replied", text: " " }).task).toMatchObject({
      to: "blocked",
      reason: expect.stringContaining("gave no reply"),
    });
    // One already blocked stays so; anything open still holds it, and a failure or stop does as before.
    expect(shown(again("blocked", unfinished).task)).toBe("stay");
    expect(shown(again("active", unfinished, [deadline("n1")]).task)).toBe("→waiting");
    expect([shown(again("active", ENDINGS.failed).task), shown(again("active", ENDINGS.stopped).task)]).toEqual([
      "stay",
      "→waiting",
    ]);
    // A blocker it reported, in the turn or the one it was sent back for, blocks it on that blocker,
    // which its lead already heard: no send-back, and no second blocker of the hub's own (#1086).
    const reported = (sentBack: boolean, lastReport: "blocker" | "finding", state: TaskState = "active") =>
      turnEnded({
        runner: "member",
        task: task(state),
        ending: unfinished,
        ledger: [],
        carried: new Set(),
        sentBack,
        lastReport,
      }).task;
    expect(reported(false, "blocker")).toEqual({ _tag: "Move", to: "blocked" });
    expect(reported(true, "blocker")).toEqual({ _tag: "Move", to: "blocked" });
    expect(shown(reported(false, "blocker", "blocked"))).toBe("stay");
    // A finding is not a blocker: it still sends the member back to finish.
    expect(shown(reported(false, "finding"))).toBe("back");
    // A step and the root never send back.
    expect(shown(decide("step", "active", unfinished).task)).toBe("complete|→failed");
    expect(shown(decide("root", "active", unfinished).task)).toBe("stay");
  });
});
