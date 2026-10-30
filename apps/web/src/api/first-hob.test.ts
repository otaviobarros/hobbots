import { CreateAgentPayload } from "@hobbots/api";
import { RuntimeModel, RuntimeModels, STARTER_ROLES, starterRole } from "@hobbots/domain";
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
  pickLook,
  pickModel,
  pickRole,
  reopenDraft,
  restoreDraft,
  roleGroups,
  roleRequestUrl,
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

  it("gives a draft saved before it had chores its role's sample ones", () => {
    const { chores: _, choresEdited: __, ...older } = draft({ role: "writer" });
    expect(restoreDraft(older)).toMatchObject({ chores: sampleChores("writer"), choresEdited: false });
  });

  // covers AG-001
  it("[TC-AG-080] moves a draft saved with a craft to the matching role, or to a title of the user's own", () => {
    const { role: _, ownTitle: __, ownSigil: ___, hat: ____, tool: _____, ...rest } = draft();
    const saved = (kind: string, craft = "") => ({ ...rest, kind, craft }) as unknown as Partial<FirstHobDraft>;
    expect(restoreDraft(saved("scribe"))).toMatchObject({ role: "writer", hat: "pointed", tool: "quill" });
    expect(restoreDraft(saved("keeper"))).toMatchObject({ role: "bookkeeper", hat: "beanie", tool: "quill" });
    const own = restoreDraft(saved("custom", "Garden plans"));
    expect(own).toMatchObject({ role: null, ownTitle: "Garden plans", ownSigil: "assistant", hat: null, tool: null });
    expect(own).not.toHaveProperty("kind");
    expect(own).not.toHaveProperty("craft");
    expect(restoreDraft(saved("constructor", "Odd"))).toMatchObject({ role: null, ownTitle: "Odd" });
  });

  it("sends the same request on every retry once submitted, and a new id after a rejection", () => {
    const sent = submitDraft(draft({ name: "Wren" }));
    expect(sent.submitted).toMatchObject({ id, name: "Wren" });
    // A draft already sent keeps its request, whatever the draft says now.
    expect(submitDraft({ ...sent, name: "Moss" }).submitted).toBe(sent.submitted);

    const reopened = reopenDraft(sent, () => "another");
    expect(reopened).toMatchObject({ id: "another", name: "Wren", submitted: null });
  });

  it("finds roles by every word of the search, in title or note, within a family", () => {
    const all = roleGroups("");
    expect(all.flatMap((group) => group.roles)).toHaveLength(STARTER_ROLES.length);
    expect(roleGroups("", "leadership").map((group) => group.family)).toEqual(["leadership"]);
    const code = roleGroups("CODE").flatMap((group) => group.roles);
    expect(code).toContain("engineer");
    expect(code.every((id) => `${starterRole(id).title} ${starterRole(id).note}`.toLowerCase().includes("code"))).toBe(
      true,
    );
    expect(roleGroups("code", "life")).toEqual([]);
    expect(roleGroups("no such role")).toEqual([]);
  });

  it("keeps the name when another role is picked", () => {
    expect(pickRole(draft(), "writer").name).toBe("Pip");
    expect(pickRole(draft({ name: "Wren", named: true }), null).name).toBe("Wren");
  });

  it("brings a role's sample chores until the user writes their own", () => {
    expect(draft().chores).toBe(sampleChores("assistant"));
    expect(pickRole(draft(), "researcher").chores).toBe(sampleChores("researcher"));
    expect(pickRole(draft(), "frontend").chores).toBe(sampleChores("frontend"));
    expect(pickRole(draft(), null).chores).toBe("");
    const own = draft({ chores: "Water the plants.", choresEdited: true });
    expect(pickRole(own, "engineer").chores).toBe("Water the plants.");
  });

  it("adds the chores to the instructions in the user's words, and leaves out blank ones", () => {
    const payload = firstHobPayload(draft({ name: "Moss", chores: "  Water the plants.  " }));
    expect(payload.instructions).toBe("Your chores, in the user's words:\nWater the plants.");
    expect(firstHobPayload(draft({ chores: " " })).instructions).toBe("");
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

  it("asks for a name and, for a role of its own, a title", () => {
    expect(draftProblem(draft())).toBeUndefined();
    expect(draftProblem(draft({ name: "  " }))).toBe("Give your hob a name");
    expect(draftProblem(draft({ role: null, ownTitle: " " }))).toBe("Give your hob's role a title");
  });

  it("builds the create request from what was chosen", () => {
    const payload = firstHobPayload(
      pickRole(draft({ name: " Tinker ", lookSeed: 77, lookColor: "ember", model: "opus", effort: "max" }), "engineer"),
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
    // The hub tells the runtime the hob's name and role; the instructions are the chores alone.
    expect(payload.instructions).toMatch(/^Your chores, in the user's words:\n/);
  });

  it("sends the runtime's default model as no model, and its own role title in the user's words", () => {
    const payload = firstHobPayload({ ...pickRole(draft({ model: "default" }), null), ownTitle: " Garden plans " });
    expect(payload.model).toBeNull();
    expect(payload).toMatchObject({ role: null, roleTitle: "Garden plans", sigil: "assistant", hat: null, tool: null });
    expect(payload.instructions).not.toContain("a hob in Hobbots");
    expect(roleTitleOf(pickRole(draft(), "bookkeeper"))).toBe("Bookkeeper");
  });

  // covers AG-001
  it("[TC-AG-081] sends a custom title with its borrowed sigil, and the hat and tool as changed next to the look", () => {
    const own = { ...pickRole(draft(), null), ownTitle: "Frontend wizard", ownSigil: "frontend" as const };
    expect(firstHobPayload({ ...own, hat: "crown", tool: "wand" })).toMatchObject({
      role: null,
      roleTitle: "Frontend wizard",
      sigil: "frontend",
      hat: "crown",
      tool: "wand",
    });
    // A starter role keeps its own title and sigil when its gear changes.
    const changed = { ...pickRole(draft(), "researcher"), tool: null };
    expect(firstHobPayload(changed)).toMatchObject({
      role: "researcher",
      roleTitle: "Researcher",
      sigil: "researcher",
      hat: "hood",
      tool: null,
    });
    expect(() => Schema.encodeSync(CreateAgentPayload)(firstHobPayload(own))).not.toThrow();
  });
});

describe("the draft's role gear", () => {
  it("dresses a starter role in its hat and tool and leaves a title of the user's own to the seed", () => {
    const draft = newDraft(
      () => 0.5,
      () => "id",
    );
    expect(gearOf(pickRole(draft, "researcher"))).toEqual({ hat: "hood", tool: "lantern" });
    expect(gearOf(pickRole(draft, null))).toEqual({ hat: null, tool: null });
    // Changed next to the look, the gear stays until another role is picked.
    const changed = { ...pickRole(draft, "researcher"), hat: "crown" as const };
    expect(gearOf(changed)).toEqual({ hat: "crown", tool: "lantern" });
    expect(gearOf(pickRole(changed, "writer"))).toEqual({ hat: "pointed", tool: "quill" });
  });
});

describe("the hob line", () => {
  it("names the hob with its role, or the user's own words", () => {
    const draft = newDraft(
      () => 0.5,
      () => "id",
    );
    expect(hobLine(draft)).toBe("Pip the Assistant");
    expect(hobLine({ ...pickRole(draft, null), ownTitle: "Frontend engineer ", name: "Fern" })).toBe(
      "Fern the Frontend engineer",
    );
    expect(hobLine({ ...pickRole(draft, null), name: "Fern" })).toBe("Fern");
  });
});

describe("the role request link", () => {
  it("opens the role request form, with the user's own title filled in", () => {
    const form = "https://github.com/otaviobarros/hobbots/issues/new?template=5-role-request.yml";
    expect(roleRequestUrl(" ")).toBe(form);
    const url = new URL(roleRequestUrl(" Garden & pond planner "));
    expect(url.searchParams.get("template")).toBe("5-role-request.yml");
    expect(url.searchParams.get("title")).toBe("Role: Garden & pond planner");
    expect(url.searchParams.get("role-title")).toBe("Garden & pond planner");
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
