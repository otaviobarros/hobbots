import {
  type AgentId,
  BackpackBlocker,
  type BackpackDisposition,
  BackpackItem,
  BackpackItemId,
  type BackpackPayload,
  backpackPriority,
  isActionableKind,
  type QuestId,
  type TaskId,
} from "@hobbots/domain";
import { describe, expect, it } from "vitest";
import { withNewer } from "../../api/sync.ts";
import { ADA, ALDRIC, BUILD, COPY, checkpoint, QUEST, QUILL, question, task } from "../../test/quests.ts";
import { HANDLED_FOR_MS, waitingCount, waitingState, waitingView, waitingWhat } from "./backpack-model.ts";

const NOW = new Date("2026-11-02T10:00:00.000Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();

const result: BackpackPayload = {
  _tag: "result",
  task: task(COPY, { ownerId: QUILL, brief: "Draft the landing copy" }),
  artifacts: [],
};

const entry = (
  id: string,
  fields: Partial<{
    recipientId: AgentId;
    state: BackpackItem["state"];
    disposition: BackpackDisposition;
    payload: BackpackPayload;
    taskId: TaskId | null;
    questId: QuestId | null;
    createdAt: string;
    updatedAt: string;
    revision: number;
  }> = {},
) => {
  const payload = fields.payload ?? result;
  return new BackpackItem({
    id: BackpackItemId.make(id),
    recipientId: fields.recipientId ?? ALDRIC,
    kind: payload._tag,
    actionable: isActionableKind(payload._tag),
    priority: backpackPriority(payload._tag),
    state: fields.state ?? "pending",
    taskId: fields.taskId === undefined ? COPY : fields.taskId,
    questId: fields.questId ?? null,
    attemptId: null,
    threadId: null,
    dedupeKey: id,
    payload,
    notBefore: null,
    claim: null,
    fencingToken: 0,
    deliveries: [],
    disposition: fields.disposition ?? null,
    error: null,
    blockers:
      fields.state === "failed"
        ? [
            new BackpackBlocker({
              number: 1,
              reason: "retries-exhausted",
              nextAction: "retry",
              diagnostic: null,
              lastEnd: "failed",
              afterDeliveries: 3,
              raisedAt: ago(0),
              decision: null,
              decidedAt: null,
            }),
          ]
        : [],
    createdAt: fields.createdAt ?? ago(4 * 60_000),
    updatedAt: fields.updatedAt ?? ago(4 * 60_000),
    revision: fields.revision ?? 1,
  });
};

const progress: BackpackPayload = { _tag: "progress", checkpoint: checkpoint(COPY, "progress", "Halfway", 3) };
const answer: BackpackPayload = { _tag: "message", senderId: null, text: "Lead with 20% off\nand more" };

const ids = (items: ReadonlyArray<BackpackItem>) => items.map((item) => item.id as string);
const names = (id: AgentId) => ({ aldric: "Aldric", quill: "Quill", ada: "Ada" })[id as string] ?? "Someone";

describe("what a hob is waiting on", () => {
  it("names each state an item reaches, and how a resolved one was handled", () => {
    expect(waitingState(entry("a"))).toBe("waiting");
    expect(waitingState(entry("a", { state: "delivered" }))).toBe("delivered");
    expect(waitingState(entry("a", { state: "acknowledged" }))).toBe("acknowledged");
    expect(waitingState(entry("a", { state: "processing" }))).toBe("processing");
    expect(waitingState(entry("a", { state: "failed" }))).toBe("stuck");
    expect(waitingState(entry("a", { state: "resolved", disposition: { _tag: "consumed", by: "turn" } }))).toBe(
      "consumed",
    );
    expect(waitingState(entry("a", { state: "resolved", disposition: { _tag: "late", taskRevision: 3 } }))).toBe(
      "late",
    );
  });

  it("shows a member's result as awaiting its lead until the lead handled it, then a moment longer", () => {
    const pending = entry("r");
    const aldric = { kind: "hob", hobId: ALDRIC } as const;
    expect(ids(waitingView([pending], [], aldric, NOW).open)).toEqual(["r"]);
    expect(waitingView([pending], [], { kind: "hob", hobId: QUILL }, NOW).open).toEqual([]);

    const consumed = entry("r", {
      state: "resolved",
      disposition: { _tag: "consumed", by: "turn" },
      updatedAt: ago(HANDLED_FOR_MS - 1),
    });
    const view = waitingView([consumed], [], aldric, NOW);
    expect(view.open).toEqual([]);
    expect(ids(view.handled)).toEqual(["r"]);
    expect(waitingCount(view)).toBe(0);
    const later = entry("r", {
      state: "resolved",
      disposition: { _tag: "consumed", by: "turn" },
      updatedAt: ago(HANDLED_FOR_MS),
    });
    expect(waitingView([later], [], aldric, NOW).handled).toEqual([]);
  });

  it("lists stuck work first, then the most urgent and oldest, and folds routine progress into a count", () => {
    const older = entry("older", { createdAt: ago(10 * 60_000) });
    const newer = entry("newer", { createdAt: ago(60_000) });
    const urgent = entry("urgent", {
      createdAt: ago(0),
      payload: { _tag: "answer", question: question(COPY, QUILL, "Which discount?", { answer: "Yes" }) },
    });
    const stuck = entry("stuck", { state: "failed" });
    const view = waitingView(
      [newer, entry("p1", { payload: progress }), older, urgent, entry("p2", { payload: progress })],
      [stuck],
      { kind: "workspace" },
      NOW,
    );
    expect(ids(view.open)).toEqual(["stuck", "urgent", "older", "newer"]);
    expect(view.routine).toBe(2);
    expect(waitingCount(view)).toBe(4);
  });

  it("keeps a request's view to the items about its Tasks and Quests, in any hob's backpack", () => {
    const forAda = entry("ada", { recipientId: ADA, taskId: BUILD });
    const elsewhere = entry("elsewhere", { taskId: null });
    const aboutQuest = entry("quest", { taskId: null, questId: QUEST });
    const view = waitingView(
      [entry("r"), forAda, elsewhere, aboutQuest],
      [],
      { kind: "tree", taskIds: new Set([COPY, BUILD]), questIds: new Set([QUEST]) },
      NOW,
    );
    expect(ids(view.open)).toEqual(["r", "ada", "quest"]);
  });

  it("says what each item is, with who sent it", () => {
    expect(waitingWhat(entry("r"), names)).toBe(`Quill's result for "Draft the landing copy"`);
    expect(waitingWhat(entry("n", { payload: answer }), names)).toBe("Your note: Lead with 20% off");
    expect(waitingWhat(entry("m", { payload: { _tag: "message", senderId: ADA, text: "Copy is in" } }), names)).toBe(
      "Ada's message: Copy is in",
    );
    expect(waitingWhat(entry("d", { payload: { _tag: "deadline", taskId: COPY, dueAt: ago(0) } }), names)).toBe(
      "A deadline that passed",
    );
  });

  it("keeps the newer version of an item in a cached list, and drops one the list no longer keeps", () => {
    const listed = [entry("a", { revision: 2 }), entry("b")];
    const open = (item: BackpackItem) => item.state !== "failed";
    expect(withNewer(listed, entry("a", { revision: 1 }), open)).toBe(listed);
    expect(ids(withNewer(listed, entry("a", { revision: 3, state: "delivered" }), open) ?? [])).toEqual(["b", "a"]);
    expect(ids(withNewer(listed, entry("c"), open) ?? [])).toEqual(["a", "b", "c"]);
    expect(ids(withNewer(listed, entry("b", { revision: 2, state: "failed" }), open) ?? [])).toEqual(["a"]);
    expect(withNewer(undefined, entry("a"), open)).toBeUndefined();
  });
});
