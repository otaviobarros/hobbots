import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  AgentId,
  ChannelId,
  FINISH_WORK_TOOL,
  holdsEveryChatTool,
  IllegalWorkQuestTransition,
  isCalendarDay,
  MessageId,
  PASS_TOOL,
  planWorkQuestFinish,
  planWorkQuestStart,
  START_WORK_TOOL,
  WorkQuest,
  type WorkQuestDraft,
  type WorkQuestEvent,
  WorkQuestId,
  WorkQuestMachine,
  WorkQuestRefused,
  type WorkQuestState,
  WorkQuests,
} from "../src/index.ts";
import { agreesWithModel } from "../testing/machine-model.ts";

const at = (minute: number) => new Date(Date.UTC(2026, 10, 16) + minute * 60_000).toISOString();

const draft = (overrides: Partial<WorkQuestDraft> = {}): WorkQuestDraft => ({
  id: WorkQuestId.make("quest-1"),
  channelId: ChannelId.make("channel-1"),
  rootMessageId: null,
  title: " Winter market page ",
  goal: "A landing page for the winter market.",
  doneWhen: ["The page is live", "  ", "It shows the map"],
  expectedBy: "2026-12-01",
  ownerHobId: AgentId.make("hob-1"),
  requestedBy: { kind: "user", id: "user-1" },
  repository: null,
  startedFrom: MessageId.make("reply-1"),
  at: at(0),
  channelOpen: true,
  ownerTakesWork: true,
  running: null,
  ...overrides,
});

const started = (): WorkQuest => {
  const quest = planWorkQuestStart(draft());
  if (quest instanceof WorkQuestRefused) throw new Error(quest.message);
  return quest;
};

const inState = (state: WorkQuestState): WorkQuest => new WorkQuest({ ...started(), state });

/** What the model tracks of a Quest: every field a rule writes. */
interface QuestView {
  readonly state: WorkQuestState;
  readonly result: string | null;
  readonly made: ReadonlyArray<string>;
  readonly finishedFrom: string | null;
  readonly changedAt: string;
}

const view = (quest: WorkQuest): QuestView => ({
  state: quest.state,
  result: quest.result,
  made: quest.made,
  finishedFrom: quest.finishedFrom,
  changedAt: quest.changedAt,
});

// ADR 041's rules, kept apart from the machine: a running Quest waits or finishes, a reply wakes a
// waiting or done one, Stop ends any that is not stopped, and only Reopen brings a stopped one back.
const step = (m: QuestView, e: WorkQuestEvent): QuestView | "refused" => {
  const to = (state: WorkQuestState): QuestView => ({ ...m, state, changedAt: e.at });
  switch (e._tag) {
    case "Wait":
      return m.state === "active" ? to("waiting") : "refused";
    case "Wake":
      return m.state === "waiting" || m.state === "done" ? to("active") : "refused";
    case "Finish":
      return m.state === "active" || m.state === "waiting"
        ? { ...to("done"), result: e.result, made: e.made, finishedFrom: e.from }
        : "refused";
    case "Stop":
      return m.state === "stopped" ? "refused" : to("stopped");
    case "Reopen":
      return m.state === "stopped" ? to("active") : "refused";
  }
};

const time = fc.integer({ min: 0, max: 10_000 }).map(at);
const events: fc.Arbitrary<WorkQuestEvent> = fc.oneof(
  fc.record({ _tag: fc.constant("Wait" as const), at: time }),
  fc.record({ _tag: fc.constant("Wake" as const), at: time }),
  fc.record({ _tag: fc.constant("Stop" as const), at: time }),
  fc.record({ _tag: fc.constant("Reopen" as const), at: time }),
  fc.record({
    _tag: fc.constant("Finish" as const),
    at: time,
    result: fc.constantFrom("Shipped", "Page is live"),
    made: fc.array(fc.constantFrom("PR #12", "index.html"), { maxLength: 2 }),
    from: fc.constantFrom("reply-2", "reply-3").map(MessageId.make),
  }),
);

describe("WorkQuestMachine", () => {
  it("agrees with a model of ADR 041's four states over random runs of events", () => {
    agreesWithModel({
      machine: WorkQuestMachine,
      records: fc.constantFrom<WorkQuestState>("active", "waiting", "done", "stopped").map(inState),
      events,
      model: { init: view, step, view },
      isError: (result): result is IllegalWorkQuestTransition => result instanceof IllegalWorkQuestTransition,
    });
  });

  it("counts only active and waiting Quests as running", () => {
    expect(
      (["active", "waiting", "done", "stopped"] as const).map((state) => WorkQuests.isRunning(inState(state))),
    ).toEqual([true, true, false, false]);
  });
});

describe("planWorkQuestStart", () => {
  it("starts an active Quest with its fields trimmed and blank lines left out", () => {
    const quest = started();
    expect(quest).toMatchObject({
      title: "Winter market page",
      doneWhen: ["The page is live", "It shows the map"],
      expectedBy: "2026-12-01",
      state: "active",
      result: null,
      made: [],
      createdAt: at(0),
      changedAt: at(0),
    });
  });

  it("refuses a second running Quest in the same conversation", () => {
    const refused = planWorkQuestStart(draft({ id: WorkQuestId.make("quest-2"), running: started() }));
    expect(refused).toBeInstanceOf(WorkQuestRefused);
    expect((refused as WorkQuestRefused).reason).toBe("busy");
  });

  it("refuses a closed chat, a hob that is leaving, empty fields, no Done when line and a day that does not exist", () => {
    const reasons = [
      draft({ channelOpen: false }),
      draft({ ownerTakesWork: false }),
      draft({ title: "  " }),
      draft({ goal: "" }),
      draft({ doneWhen: [" ", ""] }),
      draft({ expectedBy: "2026-02-30" }),
      draft({ expectedBy: "next Friday" }),
    ].map((d) => (planWorkQuestStart(d) as WorkQuestRefused).reason);
    expect(reasons).toEqual(["channel-closed", "owner-leaving", "invalid", "invalid", "invalid", "invalid", "invalid"]);
  });

  it("reads only real calendar days", () => {
    expect(["2026-12-01", "2028-02-29", "2026-02-29", "2026-13-01", "2026-1-1"].map(isCalendarDay)).toEqual([
      true,
      true,
      false,
      false,
      false,
    ]);
  });
});

describe("planWorkQuestFinish", () => {
  const finish = { result: " Page is live ", made: ["PR #12", " "], from: MessageId.make("reply-2"), at: at(5) };

  it("ends a running Quest done, with its result and what it made", () => {
    expect(planWorkQuestFinish(started(), finish)).toMatchObject({
      state: "done",
      result: "Page is live",
      made: ["PR #12"],
      finishedFrom: "reply-2",
      changedAt: at(5),
    });
  });

  it("refuses when the hob runs no Quest here, or the Quest is not running", () => {
    expect((planWorkQuestFinish(null, finish) as WorkQuestRefused).reason).toBe("none-running");
    expect((planWorkQuestFinish(inState("stopped"), finish) as WorkQuestRefused).reason).toBe("none-running");
    expect((planWorkQuestFinish(started(), { ...finish, result: "" }) as WorkQuestRefused).reason).toBe("invalid");
  });
});

describe("A session holds the Quest tools", () => {
  // covers ADR 041 (Tools)
  it("is resumed only when it holds start_work and finish_work where they are offered (#1596)", () => {
    const offered = { taskTools: false, workTools: true };
    expect(holdsEveryChatTool([PASS_TOOL, START_WORK_TOOL, FINISH_WORK_TOOL], offered)).toBe(true);
    // A Codex session started before the Quest tools keeps the tools it started with: start a new one.
    expect(holdsEveryChatTool([PASS_TOOL], offered)).toBe(false);
    expect(holdsEveryChatTool([PASS_TOOL, START_WORK_TOOL], offered)).toBe(false);
    expect(holdsEveryChatTool([PASS_TOOL], { taskTools: false, workTools: false })).toBe(true);
  });
});
