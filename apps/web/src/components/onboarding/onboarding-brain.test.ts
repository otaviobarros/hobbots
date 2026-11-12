import { DEFAULT_MEMORY_SETTINGS } from "@hobbots/domain";
import { describe, expect, it } from "vitest";
import { setupBrain } from "./onboarding-brain.tsx";

describe("the hub's brain in setup", () => {
  it("[TC-GEN-1367-11] moves the brain to the connected provider's smallest model, and keeps a choice that runs", () => {
    // The default is on Claude; with only ChatGPT connected, setup picks ChatGPT's smallest at low effort.
    expect(setupBrain({ ...DEFAULT_MEMORY_SETTINGS, effort: "high" }, ["chatgpt"])).toMatchObject({
      provider: "chatgpt",
      model: null,
      effort: "low",
    });
    expect(setupBrain(DEFAULT_MEMORY_SETTINGS, ["claude", "chatgpt"])).toBe(DEFAULT_MEMORY_SETTINGS);
    const none = { ...DEFAULT_MEMORY_SETTINGS, provider: "none" as const };
    expect(setupBrain(none, ["chatgpt"])).toBe(none);
    expect(setupBrain(DEFAULT_MEMORY_SETTINGS, [])).toBe(DEFAULT_MEMORY_SETTINGS);
  });
});
