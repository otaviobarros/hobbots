import { DEFAULT_MEMORY_SETTINGS, type MemoryEngineHealth, RuntimeModel, RuntimeModels } from "@hobbots/domain";
import { describe, expect, it } from "vitest";
import {
  effortNote,
  effortOptions,
  engineTag,
  fallbackOptions,
  hubUsageLine,
  keptLine,
  modelHint,
  modelOptions,
  shareAnswer,
  shownModel,
  stateNotes,
  taskOptions,
  usageLine,
  withProvider,
} from "./model.ts";

const engine = (fields: Partial<MemoryEngineHealth> = {}): MemoryEngineHealth => ({
  state: "running",
  offReason: null,
  version: "3.4.2",
  restarts: 0,
  lastExit: null,
  runningSince: null,
  ...fields,
});

const model = (id: string, displayName: string, main = true, efforts: RuntimeModel["efforts"] = ["low", "high"]) =>
  new RuntimeModel({ id, displayName, description: "", efforts, main });

/** What a runtime reports, as the brain picker reads it: its default row, main models and one more. */
const claude = new RuntimeModels({
  runtime: "claude-code",
  source: "runtime",
  small: "quick",
  models: [
    model("default", "Default"),
    model("careful", "Careful"),
    model("quick", "Quick", true, []),
    model("pinned-1", "Pinned", false),
  ],
});
const codex = new RuntimeModels({
  runtime: "codex",
  source: "runtime",
  models: [model("big", "Big"), model("small", "Small")],
});

describe("the memory model's choices", () => {
  it("offers the runtime's own models as the brain picker does, and the efforts the shown model takes", () => {
    expect(modelOptions(claude, null).map((option) => option.label)).toEqual(["Careful", "Quick"]);
    expect(modelOptions(claude, "pinned-1").map((option) => option.label)).toEqual(["Careful", "Quick", "Pinned"]);
    expect(modelOptions(undefined, null)).toEqual([]);
    // No model chosen: the runtime's smallest, the one it names, else its last main model.
    expect(shownModel(DEFAULT_MEMORY_SETTINGS, claude)).toBe("quick");
    expect(shownModel({ ...DEFAULT_MEMORY_SETTINGS, provider: "chatgpt" }, codex)).toBe("small");
    expect(effortOptions(claude, "careful").map((option) => option.label)).toEqual(["Low", "High"]);
    expect(effortOptions(claude, "quick")).toEqual([]);
  });

  it("moves to the new provider's smallest model with tasks on the same, and keeps everything under No AI", () => {
    const careful = {
      ...DEFAULT_MEMORY_SETTINGS,
      model: "careful",
      tasks: { ...DEFAULT_MEMORY_SETTINGS.tasks, summaries: "none", check: "careful", answers: "same" },
    };
    expect(withProvider(careful, "chatgpt")).toMatchObject({
      provider: "chatgpt",
      model: null,
      tasks: { ...DEFAULT_MEMORY_SETTINGS.tasks, summaries: "none", check: "same", answers: "same" },
    });
    expect(withProvider(careful, "none")).toMatchObject({ provider: "none", model: "careful" });
    expect(withProvider({ ...careful, provider: "none" }, "claude")).toMatchObject({ model: "careful" });
  });

  it("names the other provider's smallest model as the fallback, and the runtime's models per task", () => {
    expect(fallbackOptions("claude", codex).map((option) => option.label)).toEqual([
      "Write simple summaries",
      "Use ChatGPT Small",
    ]);
    expect(fallbackOptions("chatgpt", claude)[1]?.label).toBe("Use Claude Quick");
    expect(fallbackOptions("chatgpt", undefined)[1]?.label).toBe("Use Claude");
    expect(taskOptions(claude, "same", true).map((option) => option.label)).toEqual([
      "Same",
      "Careful",
      "Quick",
      "No AI",
    ]);
    expect(taskOptions(codex, "same", false).map((option) => option.label)).toEqual(["Same", "Big", "Small"]);
    // A task's own model the runtime stopped offering stays shown as chosen, marked.
    expect(taskOptions(codex, "gone-2", false).map((option) => option.label)).toEqual([
      "Same",
      "Big",
      "Small",
      "gone-2 (no longer offered)",
    ]);
  });

  it("says which sign-in it uses, what effort it runs at, and what memory runs with instead", () => {
    expect(modelHint(DEFAULT_MEMORY_SETTINGS, claude)).toBe(
      "Uses your Claude Code sign-in. A small, fast model is enough for this work.",
    );
    expect(modelHint({ ...DEFAULT_MEMORY_SETTINGS, provider: "chatgpt", model: "big" }, codex)).toBe(
      "Uses your ChatGPT sign-in through Codex. A bigger model is more careful, and uses more of your plan.",
    );
    expect(modelHint({ ...DEFAULT_MEMORY_SETTINGS, provider: "none" }, undefined)).toContain("no AI");
    // Effort is low by design; one chosen before shows, with the way back to low.
    expect(effortNote({ ...DEFAULT_MEMORY_SETTINGS, model: "careful" }, claude)).toEqual({
      text: "Runs at low effort: this work needs no more.",
      lower: false,
    });
    expect(effortNote({ ...DEFAULT_MEMORY_SETTINGS, model: "careful", effort: "high" }, claude)).toEqual({
      text: "Runs at high effort, chosen before. Low is enough for this work, and faster.",
      lower: true,
    });
    // A model that takes no effort, and No AI, say nothing about it.
    expect(effortNote(DEFAULT_MEMORY_SETTINGS, claude)).toBeNull();
    expect(effortNote({ ...DEFAULT_MEMORY_SETTINGS, provider: "none" }, claude)).toBeNull();
    expect(stateNotes({ _tag: "Model", model: "quick", replaced: null, tasks: [] }, claude)).toEqual([]);
    expect(stateNotes({ _tag: "Model", model: "quick", replaced: "gone-1", tasks: [] }, claude)).toEqual([
      "gone-1 is no longer offered, so memory uses Quick instead.",
    ]);
    // The memory model is still offered, but a task's own model is not.
    expect(
      stateNotes(
        {
          _tag: "Model",
          model: "careful",
          replaced: null,
          tasks: [{ task: "check", replaced: "gone-2", model: "quick" }],
        },
        claude,
      ),
    ).toEqual(["Check now: gone-2 is no longer offered, so it uses Quick instead."]);
    expect(
      stateNotes({ _tag: "Unavailable", provider: "chatgpt", state: "limited", resetsAt: null }, codex)[0],
    ).toContain("Your ChatGPT plan reached its limit");
    expect(stateNotes({ _tag: "Unavailable", provider: "claude", state: "signedOut", resetsAt: null }, claude)).toEqual(
      ["Until it is back, summaries follow your choice below."],
    );
  });
});

describe("the memory card", () => {
  it("tags the engine's state and says why memory is off", () => {
    expect(engineTag(engine())).toEqual({ label: "Running", variant: "running" });
    expect(engineTag(engine({ state: "restarting" })).variant).toBe("waiting");
    expect(engineTag(null).label).toBe("Off");
    expect(keptLine({ engine: engine({ state: "off", offReason: "checksum" }), pages: null, bytes: null })).toContain(
      "failed its check",
    );
    expect(keptLine({ engine: null, pages: null, bytes: null })).toContain("turned off");
  });

  it("counts the pages and their size", () => {
    expect(keptLine({ engine: engine(), pages: 157, bytes: 3.2 * 1024 * 1024 }, "en-US")).toBe(
      "157 pages your hobs remember, kept as plain text files on the hub (3.2 MB).",
    );
    expect(keptLine({ engine: engine(), pages: 1, bytes: null }, "en-US")).toBe(
      "1 page your hobs remember, kept as plain text files on the hub.",
    );
  });
});

describe("how shares follow the preset", () => {
  it("lets a project share through only under Trusting, and always asks for About you", () => {
    expect(shareAnswer("careful", "project")).toBe("ask");
    expect(shareAnswer("balanced", "project")).toBe("ask");
    expect(shareAnswer("trusting", "project")).toBe("through");
    for (const preset of ["careful", "balanced", "trusting"] as const)
      expect(shareAnswer(preset, "everyone")).toBe("ask");
  });
});

describe("Usage's Memory line", () => {
  it("counts calls and tokens, or says why memory makes none", () => {
    const usage = { calls: 40, inputTokens: 90_000, outputTokens: 10_000, since: null };
    expect(usageLine({ state: { _tag: "Model", model: "quick", replaced: null, tasks: [] }, usage }, "en-US")).toBe(
      "40 calls · 100K tokens since memory last started",
    );
    expect(usageLine({ state: { _tag: "NoAi" }, usage: null })).toBe("No AI: memory makes no model calls.");
    expect(
      usageLine({
        state: { _tag: "Unavailable", provider: "claude", state: "signedOut", resetsAt: null },
        usage: null,
      }),
    ).toBe("Claude is signed out, so summaries follow your fallback for now.");
    expect(
      usageLine({ state: { _tag: "Unavailable", provider: "chatgpt", state: "limited", resetsAt: null }, usage: null }),
    ).toBe("ChatGPT is at its plan's limit, so summaries follow your fallback for now.");
    expect(usageLine(undefined)).toBeNull();
  });

  it("counts the hub's own judgments and summaries apart, once it has made one", () => {
    const usage = { calls: 2, inputTokens: 300, outputTokens: 40, since: null };
    expect(hubUsageLine({ hubUsage: usage }, "en-US")).toBe(
      "The hub's own judgments and summaries: 2 calls · 340 tokens since the hub started",
    );
    expect(hubUsageLine({ hubUsage: { ...usage, calls: 0 } })).toBeNull();
    expect(hubUsageLine({ hubUsage: null })).toBeNull();
    expect(hubUsageLine(undefined)).toBeNull();
  });
});
