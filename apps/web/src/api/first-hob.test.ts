import { RuntimeModel, RuntimeModels } from "@hobbots/domain";
import { describe, expect, it } from "vitest";
import {
  craftOf,
  draftProblem,
  type FirstHobDraft,
  firstHobPayload,
  nearbySeeds,
  newDraft,
  pickCraft,
  pickModel,
  rollName,
  rollSeed,
  settleBrain,
} from "./first-hob.ts";

const model = (id: string, efforts: RuntimeModel["efforts"]) =>
  new RuntimeModel({ id, displayName: id, description: "", efforts });

const offered = new RuntimeModels({
  runtime: "claude-code",
  source: "runtime",
  models: [model("default", ["low", "medium", "high"]), model("opus", ["low", "high", "max"]), model("quick", [])],
});

const draft = (patch: Partial<FirstHobDraft> = {}): FirstHobDraft => ({ ...newDraft(() => 0.5), ...patch });

describe("first hob draft", () => {
  it("rolls a name other than the current one", () => {
    expect(rollName("Pip", () => 0)).not.toBe("Pip");
    expect(rollName("Bramble", () => 0)).toBe("Pip");
  });

  it("rolls a look seed other than the current one", () => {
    const seed = rollSeed(0, () => 0.5);
    expect(rollSeed(seed, () => 0.5)).not.toBe(seed);
    expect(rollSeed(1, () => 0)).toBeGreaterThanOrEqual(1);
  });

  it("offers five other looks near the current one", () => {
    const seeds = nearbySeeds(4821);
    expect(seeds).toHaveLength(5);
    expect(new Set(seeds).size).toBe(5);
    expect(seeds).not.toContain(4821);
  });

  it("renames an unnamed hob after its craft and keeps a name the user chose", () => {
    expect(pickCraft(draft(), "scribe").name).toBe("Quill");
    expect(pickCraft(draft({ name: "Wren", named: true }), "scribe").name).toBe("Wren");
    expect(pickCraft(draft({ name: "Pip" }), "custom").name).toBe("Pip");
  });

  it("starts on the runtime's default model and medium effort", () => {
    expect(settleBrain(draft(), offered)).toMatchObject({ model: "default", effort: "medium" });
  });

  it("falls back when the runtime no longer offers the chosen model or effort", () => {
    expect(settleBrain(draft({ model: "gone", effort: "max" }), offered)).toMatchObject({
      model: "default",
      effort: "medium",
    });
    expect(settleBrain(draft({ model: "opus", effort: "medium" }), offered)).toMatchObject({
      model: "opus",
      effort: "low",
    });
  });

  it("keeps the effort when the new model takes it, and drops it for a model without one", () => {
    const [, opus, quick] = offered.models;
    if (!opus || !quick) throw new Error("fixture");
    expect(pickModel(draft({ model: "default", effort: "high" }), opus).effort).toBe("high");
    expect(pickModel(draft({ model: "default", effort: "medium" }), opus).effort).toBe("low");
    expect(pickModel(draft({ effort: "high" }), quick).effort).toBeNull();
  });

  it("asks for a name and, for its own craft, a description", () => {
    expect(draftProblem(draft())).toBeUndefined();
    expect(draftProblem(draft({ name: "  " }))).toBe("Give your hob a name");
    expect(draftProblem(draft({ kind: "custom", craft: " " }))).toMatch(/good at/);
  });

  it("builds the create request from what was chosen", () => {
    const payload = firstHobPayload(
      draft({ kind: "coder", name: " Tinker ", lookSeed: 77, lookColor: "ember", model: "opus", effort: "max" }),
    );
    expect(payload).toMatchObject({
      name: "Tinker",
      craft: "Coder",
      lookSeed: 77,
      lookColor: "ember",
      runtime: "claude-code",
      model: "opus",
      effort: "max",
    });
    expect(payload.instructions).toContain("Tinker");
  });

  it("sends the runtime's default model as no model, and its own craft in the user's words", () => {
    const payload = firstHobPayload(draft({ kind: "custom", craft: " Garden plans ", model: "default" }));
    expect(payload.model).toBeNull();
    expect(payload.craft).toBe("Garden plans");
    expect(craftOf(draft({ kind: "keeper" }))).toBe("Bookkeeper");
  });
});
