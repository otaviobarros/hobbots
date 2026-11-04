import { describe, expect, it } from "vitest";
import { memberWork, quest } from "../test/member-work.ts";
import { questsInProgress } from "./quest-work.ts";

describe("questsInProgress", () => {
  it("groups members' work by Quest, oldest Quest first and each party in the order it joined", () => {
    const campaign = quest("q1", "aldric", 0);
    const keywords = quest("q2", "ada", 5);
    const groups = questsInProgress([
      memberWork("keywords", "pip", keywords, "waiting", 6),
      memberWork("build", "ada", campaign, "active", 2),
      memberWork("copy", "quill", campaign, "completed", 1),
    ]);
    expect(groups.map((group) => [group.quest.id, group.members.map((each) => each.task.id)])).toEqual([
      ["q1", ["copy", "build"]],
      ["q2", ["keywords"]],
    ]);
  });

  it("has nothing to show without work", () => {
    expect(questsInProgress([])).toEqual([]);
  });
});
