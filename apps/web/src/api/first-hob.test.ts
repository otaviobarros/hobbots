import { CreateAgentPayload } from "@hobbots/api";
import { RuntimeModel, RuntimeModels } from "@hobbots/domain";
import { Schema } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  draftProblem,
  type FirstHobDraft,
  firstHobPayload,
  gearOf,
  hobLine,
  keepDraft,
  keepSummonDraft,
  keptDraftOrStored,
  keptSummonDraft,
  nearbySeeds,
  newDraft,
  pickCraft,
  pickLook,
  pickModel,
  reopenDraft,
  restoreDraft,
  roleTitleOf,
  rollLook,
  rollName,
  rollSeed,
  sampleChores,
  settleBrain,
  settleSummonDraft,
  splitModels,
  submitDraft,
} from "./first-hob.ts";

const model = (id: string, efforts: RuntimeModel["efforts"]) =>
  new RuntimeModel({ id, displayName: id, description: "", efforts, main: true });

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

  // covers AG-001
  it("[TC-AG-074] moves a request sent before roles to the role the hub gave its hob, so a retry still sends", () => {
    const legacy = (craft: string) => {
      const { role: _, roleTitle: __, sigil: ___, hat: ____, tool: _____, ...rest } = firstHobPayload(draft());
      return draft({ submitted: { ...rest, craft } as unknown as FirstHobDraft["submitted"] });
    };
    const scribe = restoreDraft(legacy("Scribe"));
    // The same fields migration 0010 gave a hob created as a Scribe, with the id and instructions sent.
    expect(scribe.submitted).toEqual({
      ...firstHobPayload(draft()),
      role: "writer",
      roleTitle: "Writer",
      sigil: "writer",
      hat: null,
      tool: null,
    });
    expect(restoreDraft(legacy("Guide")).submitted).toMatchObject({
      id,
      role: null,
      roleTitle: "Guide",
      sigil: "assistant",
      hat: null,
      tool: null,
    });
    // A custom title that names an object property is still the user's own words.
    for (const title of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
      expect(restoreDraft(legacy(title)).submitted).toMatchObject({ role: null, roleTitle: title, sigil: "assistant" });
    }
    // Every retry repeats the upgraded request, which the API client can encode.
    const retried = submitDraft(scribe).submitted;
    expect(retried).toBe(scribe.submitted);
    expect(() => Schema.encodeSync(CreateAgentPayload)(retried)).not.toThrow();
    expect(restoreDraft(draft({ submitted: firstHobPayload(draft()) })).submitted).toEqual(firstHobPayload(draft()));
  });

  it("gives a draft saved before it had chores its craft's sample ones", () => {
    const { chores: _, choresEdited: __, ...older } = draft({ kind: "scribe" });
    expect(restoreDraft(older)).toMatchObject({ chores: sampleChores("scribe"), choresEdited: false });
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

  it("brings a craft's sample chores until the user writes their own", () => {
    expect(draft().chores).toBe(sampleChores("helper"));
    expect(pickCraft(draft(), "researcher").chores).toBe(sampleChores("researcher"));
    expect(pickCraft(draft(), "custom").chores).toBe("");
    const own = draft({ chores: "Water the plants.", choresEdited: true });
    expect(pickCraft(own, "coder").chores).toBe("Water the plants.");
  });

  it("adds the chores to the instructions in the user's words, and leaves out blank ones", () => {
    const payload = firstHobPayload(draft({ name: "Moss", chores: "  Water the plants.  " }));
    expect(payload.instructions.endsWith("Your chores, in the user's words:\nWater the plants.")).toBe(true);
    expect(firstHobPayload(draft({ chores: " " })).instructions).not.toContain("chores");
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

  it("shows the main models first and keeps the rest for More models", () => {
    const older = new RuntimeModel({ ...model("claude-opus-4-8", []), main: false });
    const { main, more } = splitModels([...offered.models, older]);
    expect(main.map((m) => m.id)).toEqual(["default", "opus", "quick"]);
    expect(more.map((m) => m.id)).toEqual(["claude-opus-4-8"]);
    expect(splitModels([older]).main).toEqual([older]);
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
      role: "engineer",
      roleTitle: "Software engineer",
      sigil: "engineer",
      hat: "beanie",
      tool: "wrench",
      lookSeed: 77,
      lookColor: "ember",
      runtime: "claude-code",
      model: "opus",
      effort: "max",
    });
    expect(payload.instructions).toContain("Tinker");
  });

  it("sends the runtime's default model as no model, and its own role title in the user's words", () => {
    const payload = firstHobPayload(draft({ kind: "custom", craft: " Garden plans ", model: "default" }));
    expect(payload.model).toBeNull();
    expect(payload).toMatchObject({ role: null, roleTitle: "Garden plans", sigil: "assistant", hat: null, tool: null });
    expect(roleTitleOf(draft({ kind: "keeper" }))).toBe("Bookkeeper");
  });
});

describe("the draft's role gear", () => {
  it("dresses a starter role in its hat and tool and leaves a title of the user's own to the seed", () => {
    const draft = newDraft(
      () => 0.5,
      () => "id",
    );
    expect(gearOf({ ...draft, kind: "researcher" })).toEqual({ hat: "hood", tool: "lantern" });
    expect(gearOf({ ...draft, kind: "custom", craft: "Gardening" })).toEqual({ hat: null, tool: null });
  });
});

describe("the hob line", () => {
  it("names the hob with its role, or the user's own words", () => {
    const draft = newDraft(
      () => 0.5,
      () => "id",
    );
    expect(hobLine(draft)).toBe("Pip the Assistant");
    expect(hobLine({ ...draft, kind: "custom", craft: "Gardening ", name: "Moss" })).toBe("Moss, good at gardening");
  });
});

describe("the kept first-hob draft", () => {
  afterEach(() => {
    keepDraft(null);
    keepSummonDraft(null);
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

  it("keeps Summon's draft apart from the first hob's", () => {
    keepDraft(draft({ name: "Pip" }));
    keepSummonDraft(draft({ name: "Moss" }));
    expect(keptDraftOrStored()).toMatchObject({ name: "Pip" });
    expect(keptSummonDraft()).toMatchObject({ name: "Moss" });
    keepSummonDraft(null);
    expect(keptSummonDraft()).toBeNull();
    expect(keptDraftOrStored()).toMatchObject({ name: "Pip" });
  });

  it("forgets the summoned hob's draft once its request settles", () => {
    const sent = submitDraft(draft({ name: "Moss" }));
    keepSummonDraft(sent);
    settleSummonDraft(sent.id, null);
    expect(keptSummonDraft()).toBeNull();
  });

  it("leaves a newer draft alone when an earlier summon settles late", () => {
    const sent = submitDraft(draft({ name: "Moss" }));
    keepSummonDraft(sent);
    // The user reopened Summon after Moss joined the list and started on the next hob.
    const next = draft({ id: "00000000-0000-4000-8000-000000000002", name: "Quill" });
    keepSummonDraft(next);
    settleSummonDraft(sent.id, null);
    expect(keptSummonDraft()).toMatchObject({ id: next.id, name: "Quill" });
    settleSummonDraft(sent.id, reopenDraft(sent));
    expect(keptSummonDraft()).toMatchObject({ id: next.id, name: "Quill" });
  });
});
