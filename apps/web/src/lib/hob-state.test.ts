import { AgentId } from "@hobbots/domain";
import { describe, expect, it } from "vitest";
import { hobNeeds, presenceState, sceneOrder, threadState } from "./hob-state.ts";

describe("presenceState", () => {
  it("shows the presence the hub published", () => {
    for (const presence of ["paused", "needs-you", "working", "thinking", "on-command", "idle"] as const)
      expect(presenceState(presence)).toBe(presence);
  });
  it("rests before the hub has published the hob", () => expect(presenceState(undefined)).toBe("idle"));
});

describe("threadState", () => {
  it("follows what the thread's reply is doing", () => expect(threadState("working", "thinking")).toBe("thinking"));
  it("rests when no reply runs", () => expect(threadState("needs-you", undefined)).toBe("idle"));
  it("waits on a command once the reply only waits on one", () =>
    expect(threadState("on-command", "waiting")).toBe("on-command"));
  it("shows paused over a reply still running", () => expect(threadState("paused", "working")).toBe("paused"));
});

describe("sceneOrder", () => {
  it("puts busy hobs before resting and paused ones, keeping order within a state", () => {
    const crew = [
      { name: "Ada", state: "paused" as const },
      { name: "Bo", state: "idle" as const },
      { name: "Cy", state: "working" as const },
      { name: "Di", state: "idle" as const },
      { name: "Ed", state: "thinking" as const },
    ];
    expect(sceneOrder(crew).map((c) => c.name)).toEqual(["Cy", "Ed", "Bo", "Di", "Ada"]);
  });
});

describe("hobNeeds", () => {
  const ada = AgentId.make("ada");
  const aldric = AgentId.make("aldric");
  const pip = AgentId.make("pip");
  const asks = (text: string, askerId: AgentId, chain: ReadonlyArray<AgentId>) => ({
    question: { askerId, chain, text },
  });

  it("marks a member that asks you, and the lead whose chat holds its question", () => {
    const needs = hobNeeds({ approvals: [], blockers: [], questions: [asks("Which store?", ada, [aldric])] });
    expect(needs.get(ada)).toEqual({ kind: "question", text: "Which store?", askerId: ada });
    expect(needs.get(aldric)).toEqual({ kind: "question", text: "Which store?", askerId: ada });
  });

  it("marks a hob that asks you straight, with nobody leading it", () => {
    const needs = hobNeeds({ approvals: [], blockers: [], questions: [asks("Which store?", ada, [])] });
    expect([...needs.keys()]).toEqual([ada]);
  });

  it("puts a pending request before a question, and leaves decided requests out", () => {
    const needs = hobNeeds({
      approvals: [
        { agentId: ada, operation: "push", state: "pending" },
        { agentId: pip, operation: "push", state: "approved" },
      ],
      blockers: [],
      questions: [asks("Which store?", ada, [aldric])],
    });
    expect(needs.get(ada)).toEqual({ kind: "approval", operation: "push" });
    expect(needs.has(pip)).toBe(false);
  });
});
