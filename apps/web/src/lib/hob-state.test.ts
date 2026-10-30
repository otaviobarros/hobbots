import { describe, expect, it } from "vitest";
import { hobState, sceneOrder } from "./hob-state.ts";

describe("hobState", () => {
  const hob = { id: "aldric" };
  const threads = [{ id: "t1" }, { id: "t2" }];

  it("rests when no thread streams", () => expect(hobState(hob, threads, {})).toBe("idle"));
  it("works while any thread writes", () =>
    expect(hobState(hob, threads, { t1: "thinking", t2: "working" })).toBe("working"));
  it("thinks before the first words arrive", () => expect(hobState(hob, threads, { t2: "thinking" })).toBe("thinking"));
  it("ignores activity on other hobs' threads", () => expect(hobState(hob, threads, { t9: "working" })).toBe("idle"));
  it("shows paused over activity", () =>
    expect(hobState({ ...hob, status: "paused" }, threads, { t1: "working" })).toBe("paused"));
  it("treats a hob with no status as active", () => expect(hobState(hob, undefined, {})).toBe("idle"));
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
