import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { DEFAULT_MEMORY_SETTINGS, hubTaskModel, MemorySettings } from "../src/memory-settings.ts";

// The hub's brain (ADR 037, issue #1367): the memory model of ADR 028, with a model per hub task.

const decode = Schema.decodeUnknownSync(MemorySettings);

describe("the hub's brain settings", () => {
  it("reads a memory model chosen before the hub's tasks existed, with each of them on the same model", () => {
    const saved = {
      provider: "chatgpt",
      model: "big",
      effort: "medium",
      fallback: "other",
      tasks: { summaries: "none", check: "small", answers: "same" },
    };
    expect(decode(saved)).toEqual({
      ...saved,
      tasks: { ...saved.tasks, brief: "same", chapters: "same", judgments: "same" },
    });
  });

  it("asks a hub task's own model, else the brain's, and no model with No AI for the brain or the task", () => {
    const chosen = {
      ...DEFAULT_MEMORY_SETTINGS,
      model: "careful",
      tasks: { ...DEFAULT_MEMORY_SETTINGS.tasks, brief: "quick", chapters: "none" },
    };
    expect(hubTaskModel(chosen, "brief")).toEqual({ provider: "claude", model: "quick" });
    expect(hubTaskModel(chosen, "judgments")).toEqual({ provider: "claude", model: "careful" });
    expect(hubTaskModel(chosen, "chapters")).toBe("none");
    expect(hubTaskModel({ ...chosen, provider: "none" }, "brief")).toBe("none");
    expect(hubTaskModel(DEFAULT_MEMORY_SETTINGS, "judgments")).toEqual({ provider: "claude", model: null });
  });
});
