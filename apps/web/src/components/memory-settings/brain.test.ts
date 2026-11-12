import { DEFAULT_MEMORY_SETTINGS, RuntimeModel, RuntimeModels } from "@hobbots/domain";
import { describe, expect, it } from "vitest";
import { brainGroups, brainValue, isRecommended, NO_BRAIN, pickBrain, vendorOf } from "./brain.ts";

const model = (id: string, displayName: string) =>
  new RuntimeModel({ id, displayName, description: "", efforts: ["low", "high"], main: true });

const claude = new RuntimeModels({
  runtime: "claude-code",
  source: "runtime",
  small: "quick",
  models: [model("default", "Default"), model("careful", "Careful"), model("quick", "Quick")],
});
const codex = new RuntimeModels({
  runtime: "codex",
  source: "runtime",
  models: [model("big", "Big"), model("small", "Small")],
});
const models = { claude, chatgpt: codex };

const labels = (groups: ReturnType<typeof brainGroups>) =>
  groups.map((group) => [group.label, group.options.map((option) => option.label)]);

describe("the hub's brain as one list", () => {
  it("[TC-GEN-1367-09] lists every connected runtime's models, grouped, its smallest first and recommended", () => {
    expect(labels(brainGroups(DEFAULT_MEMORY_SETTINGS, ["claude", "chatgpt"], models))).toEqual([
      ["Claude", ["Quick (recommended)", "Careful"]],
      ["ChatGPT", ["Small (recommended)", "Big"]],
    ]);
    // Only what is connected, plus the provider chosen before.
    expect(labels(brainGroups({ ...DEFAULT_MEMORY_SETTINGS, provider: "none" }, ["chatgpt"], models))).toEqual([
      ["ChatGPT", ["Small (recommended)", "Big"]],
    ]);
    expect(brainGroups(DEFAULT_MEMORY_SETTINGS, ["chatgpt"], models).map((group) => group.label)).toEqual([
      "Claude",
      "ChatGPT",
    ]);
    // Before a runtime answers, it still offers its smallest, and a chosen model shows by its id.
    expect(labels(brainGroups({ ...DEFAULT_MEMORY_SETTINGS, model: "careful" }, ["claude"], {}))).toEqual([
      ["Claude", ["Its smallest model (recommended)", "careful"]],
    ]);
    // A chosen model the runtime stopped offering is marked.
    expect(labels(brainGroups({ ...DEFAULT_MEMORY_SETTINGS, model: "gone" }, ["claude"], models))).toEqual([
      ["Claude", ["Quick (recommended)", "Careful", "gone (no longer offered)"]],
    ]);
  });

  it("[TC-GEN-1367-10] names the choice, with a runtime's smallest as its own, and saves a pick at low effort", () => {
    expect(brainValue(DEFAULT_MEMORY_SETTINGS, models)).toBe("claude:");
    expect(brainValue({ ...DEFAULT_MEMORY_SETTINGS, model: "quick" }, models)).toBe("claude:");
    expect(brainValue({ ...DEFAULT_MEMORY_SETTINGS, model: "careful" }, models)).toBe("claude:careful");
    expect(brainValue({ ...DEFAULT_MEMORY_SETTINGS, provider: "none" }, models)).toBe(NO_BRAIN);
    expect(isRecommended("claude:")).toBe(true);
    expect(isRecommended("claude:careful")).toBe(false);
    expect(isRecommended(NO_BRAIN)).toBe(false);

    const careful = { ...DEFAULT_MEMORY_SETTINGS, model: "careful", effort: "high" as const };
    expect(pickBrain(careful, "claude:")).toMatchObject({ provider: "claude", model: null, effort: "low" });
    // Another provider starts its tasks over, since a model belongs to one runtime.
    expect(
      pickBrain({ ...careful, tasks: { ...careful.tasks, check: "careful", brief: "none" } }, "chatgpt:big"),
    ).toMatchObject({ provider: "chatgpt", model: "big", effort: "low", tasks: { check: "same", brief: "none" } });
    // No AI keeps the rest, so turning AI back on picks up where it was.
    expect(pickBrain(careful, NO_BRAIN)).toMatchObject({ provider: "none", model: "careful", effort: "high" });
    expect(pickBrain(careful, "gemini:flash")).toBe(careful);
    expect(vendorOf("codex")).toBe("chatgpt");
    expect(vendorOf("claude-code")).toBe("claude");
  });
});
