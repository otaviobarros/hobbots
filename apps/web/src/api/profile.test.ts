import { Agent, AgentId, RuntimeModel, RuntimeModels } from "@hobbots/domain";
import { describe, expect, it } from "vitest";
import { brainLine, isDirty, profileDraft, profileEdit, retiredSummary } from "./profile.ts";

const model = (id: string, displayName: string, efforts: RuntimeModel["efforts"]) =>
  new RuntimeModel({ id, displayName, description: "", efforts });

const offered = new RuntimeModels({
  runtime: "claude-code",
  source: "runtime",
  models: [model("default", "Default", ["low", "medium", "high"]), model("opus", "Opus", ["low", "high", "max"])],
});

const hob = (patch: Partial<Agent> = {}) =>
  new Agent({
    id: AgentId.make("8a1f6c2e-3b4d-4e5f-9a6b-7c8d9e0f1a2b"),
    name: "Pip",
    craft: "Scribe",
    runtime: "claude-code",
    model: null,
    effort: "medium",
    instructions: "Write short answers.",
    lookSeed: 4821,
    lookColor: "violet",
    configVersion: 1,
    createdAt: "2026-10-02T09:00:00.000Z",
    ...patch,
  });

describe("hob profile", () => {
  it("starts from the hob's configuration, with no model as the runtime's default", () => {
    expect(profileDraft(hob(), offered)).toEqual({
      instructions: "Write short answers.",
      model: "default",
      effort: "medium",
    });
    expect(profileDraft(hob({ model: "opus", effort: "max" }), offered)).toMatchObject({
      model: "opus",
      effort: "max",
    });
  });

  it("settles a model the runtime no longer offers to its default", () => {
    expect(profileDraft(hob({ model: "retired-model", effort: "max" }), offered)).toMatchObject({
      model: "default",
      effort: "medium",
    });
  });

  it("sends only the fields that changed, and nothing for an untouched draft", () => {
    const pip = hob();
    const draft = profileDraft(pip, offered);
    expect(profileEdit(pip, draft)).toEqual({});
    expect(isDirty(draft, draft)).toBe(false);

    const edited = { ...draft, instructions: "Write long answers." };
    expect(profileEdit(pip, edited)).toEqual({ instructions: "Write long answers." });
    expect(isDirty(draft, edited)).toBe(true);

    expect(profileEdit(pip, { ...draft, model: "opus", effort: "high" })).toEqual({ model: "opus", effort: "high" });
    expect(profileEdit(hob({ model: "opus" }), { ...draft, model: "default" })).toEqual({ model: null });
  });

  it("names the brain by the runtime's display names", () => {
    expect(brainLine(hob({ model: "opus", effort: "high" }), offered)).toBe("Claude · Opus · High effort");
    expect(brainLine(hob({ effort: null }), offered)).toBe("Claude · Default");
    expect(brainLine(hob({ model: "opus", effort: null }))).toBe("Claude · opus");
  });

  it("says what retiring did with the hob's work", () => {
    expect(retiredSummary("Pip", "stop", false)).toBe("Pip is asleep. Its threads are kept and stay readable.");
    expect(retiredSummary("Pip", "finish", true)).toMatch(/^Pip finishes the replies/);
    expect(retiredSummary("Pip", "stop", true)).toMatch(/^Pip's running replies were stopped/);
  });
});
