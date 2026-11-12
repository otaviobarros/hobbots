import { QuestId, type QuestState, type QuestSummary, ThreadId } from "@hobbots/domain";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import fc from "fast-check";
import { afterEach, describe, expect, it, vi } from "vitest";

// Each read waits until the test answers it, with what the hub held when the read was taken.
const pending: Array<(summaries: ReadonlyArray<QuestSummary>) => void> = [];
vi.mock("./client.ts", () => ({
  call: () =>
    new Promise((resolve) =>
      pending.push((summaries) => resolve({ cursor: "e.1", summaries: summaries as ReadonlyArray<QuestSummary> })),
    ),
}));

const { activeSummariesQuery, questSummaryChanged } = await import("./quest-summaries.ts");

const QUESTS = [QuestId.make("q1"), QuestId.make("q2"), QuestId.make("q3")];
const chat = ThreadId.make("t1");

const summary = (questId: QuestId, revision: number, done: number, state: QuestState = "active") =>
  ({
    questId,
    threadId: chat,
    state,
    tones: { needs: 0, working: 1, waiting: 0, done, problem: 0, idle: 0 },
    needsYou: 0,
    readyForReview: 0,
    revision,
  }) as unknown as QuestSummary;

const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

const watched = () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const observer = new QueryObserver(client, activeSummariesQuery);
  const unsubscribe = observer.subscribe(() => {});
  const shown = () => observer.getCurrentResult().data;
  return { client, shown, unsubscribe };
};

afterEach(() => {
  pending.length = 0;
});

/** What can happen: the hub changes a Quest's summary, or the oldest read on its way answers. */
type Step = { readonly kind: "change"; readonly quest: number; readonly ended: boolean } | { readonly kind: "answer" };

const steps = fc.array(
  fc.oneof(
    fc.record({
      kind: fc.constant("change" as const),
      quest: fc.integer({ min: 0, max: QUESTS.length - 1 }),
      ended: fc.boolean(),
    }),
    fc.constant({ kind: "answer" as const }),
  ),
  { maxLength: 12 },
);

describe("the hub's Quest summaries in the window", () => {
  // covers UX-002
  it("[TC-UX-1374-03] ends with each Quest's newest summary, whatever order changes and reads arrive in", async () => {
    await fc.assert(
      fc.asyncProperty(steps, async (script: ReadonlyArray<Step>) => {
        pending.length = 0;
        const view = watched();
        // The model: what the hub holds, and each read with what it held when the read was taken.
        const hub = new Map<QuestId, QuestSummary>();
        const taken: Array<ReadonlyArray<QuestSummary>> = [];
        let revision = 0;
        const took = () => {
          while (taken.length < pending.length) taken.push([...hub.values()].filter((each) => each.state === "active"));
        };
        await settled();
        took();
        let answered = 0;
        for (const step of script) {
          if (step.kind === "change") {
            const questId = QUESTS[step.quest] ?? QUESTS[0];
            if (questId === undefined) continue;
            revision += 1;
            const next = summary(questId, revision, revision, step.ended ? "completed" : "active");
            hub.set(questId, next);
            questSummaryChanged(view.client, next);
          } else if (answered < pending.length) {
            pending[answered]?.(taken[answered] ?? []);
            answered += 1;
          }
          await settled();
          took();
        }
        // Every read still on its way answers, in order, as the hub would.
        while (answered < pending.length) {
          pending[answered]?.(taken[answered] ?? []);
          answered += 1;
          await settled();
          took();
        }
        const shown = view.shown() ?? {};
        for (const [questId, newest] of hub) {
          // An ended Quest the active read never saw need not be held; one it holds is never older.
          const held = shown[questId];
          if (newest.state === "active" || held !== undefined) expect(held).toEqual(newest);
        }
        view.unsubscribe();
      }),
      { numRuns: 60 },
    );
  });

  it("keeps a newer summary over an older one, and patches nothing before the first read", async () => {
    const view = watched();
    await settled();
    const [q1] = QUESTS;
    if (q1 === undefined) throw new Error("no Quest");
    pending[0]?.([summary(q1, 3, 1)]);
    await settled();
    questSummaryChanged(view.client, summary(q1, 2, 0));
    expect(view.shown()?.[q1]?.revision).toBe(3);
    questSummaryChanged(view.client, summary(q1, 4, 2));
    expect(view.shown()?.[q1]?.revision).toBe(4);
    view.unsubscribe();

    const unread = new QueryClient();
    questSummaryChanged(unread, summary(q1, 5, 2));
    expect(unread.getQueryData(activeSummariesQuery.queryKey)).toBeUndefined();
  });
});
