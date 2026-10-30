import { Agent, AgentId, RuntimeModel, RuntimeModels } from "@hobbots/domain";
import { describe, expect, it } from "vitest";
import { brainLine, isDirty, profileDraft, profileEdit, rebaseDraft, retiredSummary } from "./profile.ts";

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
    roleTitle: "Writer",
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

  it("keeps a change saved elsewhere that the user did not touch, and sends only the user's edit", () => {
    const before = hob();
    const base = profileDraft(before, offered);
    const draft = { ...base, instructions: "Write long answers." };
    // Another window switches the model while this one edits the instructions.
    const after = hob({ model: "opus", effort: "high", configVersion: 2 });
    const rebased = rebaseDraft(base, profileDraft(after, offered), draft);
    expect(rebased).toEqual({ instructions: "Write long answers.", model: "opus", effort: "high" });
    expect(profileEdit(after, rebased)).toEqual({ instructions: "Write long answers." });
  });

  it("keeps what the user typed after pressing Save once the save answers", () => {
    const before = hob();
    const sent = { ...profileDraft(before, offered), instructions: "Write long answers." };
    const typing = { ...sent, instructions: "Write long answers. In French." };
    const saved = hob({ instructions: "Write long answers.", configVersion: 2 });
    const fresh = profileDraft(saved, offered);
    const rebased = rebaseDraft(sent, fresh, typing);
    expect(rebased.instructions).toBe("Write long answers. In French.");
    expect(isDirty(fresh, rebased)).toBe(true);
    expect(rebaseDraft(sent, fresh, sent)).toEqual(fresh);
  });

  it("keeps an edit back to the old text when the save's own update arrives before its answer", () => {
    const before = hob();
    const base = profileDraft(before, offered);
    const sent = { ...base, instructions: "Write long answers." };
    // While the save is on its way, the user puts the old text back.
    const restored = base;
    const saved = profileDraft(hob({ instructions: "Write long answers.", configVersion: 2 }), offered);
    const afterUpdate = rebaseDraft(base, saved, restored, sent);
    expect(afterUpdate.instructions).toBe("Write short answers.");
    const afterAnswer = rebaseDraft(sent, saved, afterUpdate);
    expect(afterAnswer.instructions).toBe("Write short answers.");
    expect(isDirty(saved, afterAnswer)).toBe(true);
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
