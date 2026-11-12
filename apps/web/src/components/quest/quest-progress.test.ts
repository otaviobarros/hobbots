import { TaskId } from "@hobbots/domain";
import { describe, expect, it } from "vitest";
import { ADA, BUILD, blackFriday, CAMPAIGN, question, task, tree } from "../../test/quests.ts";
import { progressOfSummary, questProgress } from "./quest-progress.ts";

const summary = (
  tones: Partial<Record<"needs" | "working" | "waiting" | "done" | "problem" | "idle", number>>,
  needsYou = 0,
) => ({ tones: { needs: 0, working: 0, waiting: 0, done: 0, problem: 0, idle: 0, ...tones }, needsYou }) as never;

describe("questProgress", () => {
  it("[TC-UX-1374-04] shows a Quest as the hub summed it, never from its Task states", () => {
    // The tree says nothing is done and nothing needs you; the summary the hub published wins.
    const progress = questProgress(blackFriday(), summary({ done: 2, problem: 1, working: 1 }, 3));
    expect(progress).toEqual({ segments: ["done", "done", "failed", "running"], done: 2, total: 4, needs: 3 });
  });

  it("shows no progress for a Quest whose summary is not read yet", () =>
    expect(questProgress(blackFriday(), undefined)).toEqual({ segments: [], done: 0, total: 0, needs: 0 }));

  it("orders the strip from done to what needs a look to the rest", () =>
    expect(
      progressOfSummary(summary({ idle: 1, waiting: 1, working: 1, needs: 1, problem: 1, done: 1 })).segments,
    ).toEqual(["done", "failed", "blocked", "running", "waiting", "waiting"]));

  it("shows a Task working alone by its own steps and what it asks you", () => {
    const steps = ["outline", "draft"].map((id, index) =>
      task(TaskId.make(id), { state: index === 0 ? "completed" : "active", second: index + 1 }),
    );
    const alone = tree({
      tasks: [task(CAMPAIGN), ...steps],
      questions: [question(TaskId.make("draft"), ADA, "Which tone?", { recipientId: null })],
    });
    expect(questProgress(alone, undefined)).toEqual({ segments: ["done", "needs-you"], done: 1, total: 2, needs: 1 });
    expect(questProgress(tree({ tasks: [task(CAMPAIGN)] }), undefined)).toMatchObject({
      segments: ["running"],
      total: 0,
    });
  });

  it("asks nothing more once a Task working alone has ended", () => {
    const ended = tree({
      tasks: [task(CAMPAIGN, { state: "completed" })],
      questions: [question(BUILD, ADA, "Old?", { recipientId: null })],
    });
    expect(questProgress(ended, undefined).needs).toBe(0);
  });
});
