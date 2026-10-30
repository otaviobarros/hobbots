import { RuntimeModel, RuntimeModels } from "@hobbots/domain";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  craftOf,
  draftProblem,
  type FirstHobDraft,
  firstHobPayload,
  hobLine,
  keepDraft,
  keptDraftOrStored,
  nearbySeeds,
  newDraft,
  pickCraft,
  pickLook,
  pickModel,
  reopenDraft,
  restoreDraft,
  rollLook,
  rollName,
  rollSeed,
  settleBrain,
  submitDraft,
} from "./first-hob.ts";

const model = (id: string, efforts: RuntimeModel["efforts"]) =>
  new RuntimeModel({ id, displayName: id, description: "", efforts });

const offered = new RuntimeModels({
  runtime: "claude-code",
  source: "runtime",
  models: [model("default", ["low", "medium", "high"]), model("opus", ["low", "high", "max"]), model("quick", [])],
});

const id = "8a1f6c2e-3b4d-4e5f-9a6b-7c8d9e0f1a2b";
const draft = (patch: Partial<FirstHobDraft> = {}): FirstHobDraft => ({
  ...newDraft(
    () => 0.5,
    () => id,
  ),
  ...patch,
});

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

  it("keeps the nearby looks while one of them is picked, and moves them with a new look", () => {
    const start = draft({ lookSeed: 4821, lookBase: 4821 });
    const picked = pickLook(start, nearbySeeds(4821)[2] ?? 0);
    expect(nearbySeeds(picked.lookBase)).toEqual(nearbySeeds(4821));
    expect(nearbySeeds(picked.lookBase)).toContain(picked.lookSeed);
    const again = pickLook(picked, nearbySeeds(4821)[3] ?? 0);
    expect(nearbySeeds(again.lookBase)).toEqual(nearbySeeds(4821));

    const rolled = rollLook(again, () => 0.1);
    expect(rolled.lookBase).toBe(rolled.lookSeed);
    expect(rolled.lookSeed).not.toBe(again.lookSeed);
  });

  it("completes a draft saved before it had an id or nearby looks", () => {
    const { id: _, lookBase: __, submitted: ___, ...older } = draft({ name: "Wren", lookSeed: 77 });
    const restored = restoreDraft(older);
    expect(restored).toMatchObject({ name: "Wren", lookSeed: 77, lookBase: 77, submitted: null });
    expect(restored.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(restoreDraft(draft({ lookSeed: 77, lookBase: 12 }))).toMatchObject({ id, lookSeed: 77, lookBase: 12 });
  });

  it("sends the same request on every retry once submitted, and a new id after a rejection", () => {
    const sent = submitDraft(draft({ name: "Wren" }));
    expect(sent.submitted).toMatchObject({ id, name: "Wren" });
    // A draft already sent keeps its request, whatever the draft says now.
    expect(submitDraft({ ...sent, name: "Moss" }).submitted).toBe(sent.submitted);

    const reopened = reopenDraft(sent, () => "another");
    expect(reopened).toMatchObject({ id: "another", name: "Wren", submitted: null });
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
      id,
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

describe("the hob line", () => {
  it("names the hob with its craft, or the user's own words", () => {
    const draft = newDraft(
      () => 0.5,
      () => "id",
    );
    expect(hobLine(draft)).toBe("Pip the Helper");
    expect(hobLine({ ...draft, kind: "custom", craft: "Gardening ", name: "Moss" })).toBe("Moss, good at gardening");
  });
});

describe("the kept first-hob draft", () => {
  afterEach(() => {
    keepDraft(null);
    vi.unstubAllGlobals();
  });

  it("keeps the draft for the next steps when browser storage refuses it", () => {
    const refusing = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("quota");
      },
    };
    vi.stubGlobal("localStorage", refusing);
    const kept = draft({ name: "Moss" });
    keepDraft(kept);
    expect(keptDraftOrStored()).toEqual(kept);
    keepDraft(null);
    expect(keptDraftOrStored()).toBeNull();
  });
});
