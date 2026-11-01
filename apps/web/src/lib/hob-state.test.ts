import { describe, expect, it } from "vitest";
import { hobState, sceneOrder, threadState, withRequests } from "./hob-state.ts";

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
});

describe("threadState", () => {
  const hob = { status: "active" } as const;

  it("follows the thread's activity", () => expect(threadState(hob, "thinking", false)).toBe("thinking"));
  it("works while a reply streams without live activity", () =>
    expect(threadState(hob, undefined, true)).toBe("working"));
  it("rests when nothing happens", () => expect(threadState(hob, undefined, false)).toBe("idle"));
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
