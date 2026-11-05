import { DEFAULT_MEMORY_SETTINGS, type MemoryEngineHealth } from "@hobbots/domain";
import { describe, expect, it } from "vitest";
import {
  engineTag,
  fallbackOptions,
  keptLine,
  modelHint,
  modelOptions,
  shareAnswer,
  stateNote,
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

describe("the memory model's choices", () => {
  it("offers each provider's models, and none for No AI", () => {
    expect(modelOptions("claude").map((option) => option.label)).toEqual(["Haiku", "Sonnet", "Opus"]);
    expect(modelOptions("chatgpt").map((option) => option.label)).toEqual(["GPT-5.4 mini", "GPT-5.5"]);
    expect(modelOptions("none")).toEqual([]);
  });

  it("moves to the new provider's first model, and keeps the model under No AI", () => {
    const sonnet = { ...DEFAULT_MEMORY_SETTINGS, model: "sonnet" as const };
    expect(withProvider(sonnet, "chatgpt")).toMatchObject({ provider: "chatgpt", model: "mini" });
    expect(withProvider(sonnet, "none")).toMatchObject({ provider: "none", model: "sonnet" });
    expect(withProvider({ ...sonnet, provider: "none" }, "claude")).toMatchObject({ model: "sonnet" });
  });

  it("names the other provider's small model as the fallback, and the stronger model per task", () => {
    expect(fallbackOptions("claude").map((option) => option.label)).toEqual([
      "Write simple summaries",
      "Use ChatGPT GPT-5.4 mini",
    ]);
    expect(fallbackOptions("chatgpt")[1]?.label).toBe("Use Claude Haiku");
    expect(taskOptions("claude", true).map((option) => option.label)).toEqual(["Same", "Sonnet", "No AI"]);
    expect(taskOptions("chatgpt", false).map((option) => option.label)).toEqual(["Same", "GPT-5.5"]);
    expect(taskOptions("none", false)[1]?.unavailable).toBe("Pick a provider first.");
  });

  it("warns about high effort, and says what No AI and a missing key mean", () => {
    expect(modelHint({ ...DEFAULT_MEMORY_SETTINGS, effort: "high" }).warn).toBe(true);
    expect(modelHint(DEFAULT_MEMORY_SETTINGS).text).toBe(
      "Uses an Anthropic API key. A small, fast model is enough for summaries.",
    );
    expect(modelHint({ ...DEFAULT_MEMORY_SETTINGS, provider: "none" }).text).toContain("no AI");
    expect(stateNote({ _tag: "NeedsKey", provider: "chatgpt" })).toContain("can't hand ChatGPT a key yet");
    expect(stateNote({ _tag: "Model" })).toBeNull();
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
    expect(usageLine({ state: { _tag: "Model" }, usage }, "en-US")).toBe(
      "40 calls · 100K tokens since memory last started",
    );
    expect(usageLine({ state: { _tag: "NoAi" }, usage: null })).toBe("No AI: memory makes no model calls.");
    expect(usageLine({ state: { _tag: "NeedsKey", provider: "claude" }, usage: null })).toContain("no AI");
    expect(usageLine(undefined)).toBeNull();
  });
});
