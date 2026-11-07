import { AgentId, ThreadId } from "@hobbots/domain";
import { describe, expect, it } from "vitest";
import { hobNeeds, hobState, leadNeeds, sceneOrder, threadState, withRequests } from "./hob-state.ts";

describe("hobState", () => {
  const hob = { status: "active" } as const;
  const threads = [{ id: "t1" }, { id: "t2" }];

  it("rests when no thread streams", () => expect(hobState(hob, threads, {})).toBe("idle"));
  it("works while any thread writes", () =>
    expect(hobState(hob, threads, { t1: "thinking", t2: "working" })).toBe("working"));
  it("thinks before the first words arrive", () => expect(hobState(hob, threads, { t2: "thinking" })).toBe("thinking"));
  it("ignores activity on other hobs' threads", () => expect(hobState(hob, threads, { t9: "working" })).toBe("idle"));
  it("shows paused over activity", () =>
    expect(hobState({ ...hob, status: "paused" }, threads, { t1: "working" })).toBe("paused"));
  it("rests before its threads load", () => expect(hobState(hob, undefined, {})).toBe("idle"));
  // #1056: a hob that answered and waits only on a command it started is neither writing nor waiting on you.
  it("waits on a command only while no thread of it writes or thinks", () => {
    expect(hobState(hob, threads, { t1: "waiting" })).toBe("on-command");
    expect(hobState(hob, threads, { t1: "waiting", t2: "thinking" })).toBe("thinking");
    expect(hobState(hob, threads, { t1: "waiting", t2: "working" })).toBe("working");
  });
});

describe("threadState", () => {
  const hob = { status: "active" } as const;

  it("follows the thread's activity", () => expect(threadState(hob, "thinking", false)).toBe("thinking"));
  it("works while a reply streams without live activity", () =>
    expect(threadState(hob, undefined, true)).toBe("working"));
  it("rests when nothing happens", () => expect(threadState(hob, undefined, false)).toBe("idle"));
  it("waits on a command once the reply only waits on one", () =>
    expect(threadState(hob, "waiting", true)).toBe("on-command"));
  it("shows paused over a reply still streaming", () =>
    expect(threadState({ status: "paused" }, "working", true)).toBe("paused"));
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

describe("withRequests", () => {
  it("needs you while a request waits, whatever the hob is doing", () => {
    expect(withRequests("working", true)).toBe("needs-you");
    expect(withRequests("idle", true)).toBe("needs-you");
    expect(withRequests("working", false)).toBe("working");
  });
  it("keeps a paused hob paused", () => expect(withRequests("paused", true)).toBe("paused"));
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
    expect(withRequests("idle", needs.has(ada))).toBe("needs-you");
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

describe("leadNeeds", () => {
  const ada = AgentId.make("ada");
  const aldric = AgentId.make("aldric");
  const pip = AgentId.make("pip");
  const thread = ThreadId.make("t1");
  const leadOf = (id: ThreadId) => (id === thread ? aldric : undefined);

  // covers UX-002, OR-005
  it("[TC-UX-191] marks only the lead whose chat a member's request, question, stuck work or failed Task waits in", () => {
    const needs = leadNeeds({
      approvals: [
        { agentId: ada, threadId: thread, state: "pending" },
        { agentId: pip, threadId: ThreadId.make("t9"), state: "approved" },
      ],
      blockers: [{ recipientId: ada, threadId: thread }],
      questions: [{ question: { askerId: ada, chain: [aldric] } }],
      failed: [{ task: { id: "build", ownerId: ada, threadId: thread } as never, leadId: aldric }],
      leadOf,
    });
    expect([...needs]).toEqual([aldric]);
  });

  it("marks the hob itself when its chat is not known, and nobody for decided requests", () => {
    const needs = leadNeeds({
      approvals: [{ agentId: pip, threadId: ThreadId.make("t9"), state: "pending" }],
      blockers: [],
      questions: [{ question: { askerId: ada, chain: [] } }],
      failed: [],
      leadOf,
    });
    expect([...needs].sort()).toEqual([ada, pip]);
  });
});
