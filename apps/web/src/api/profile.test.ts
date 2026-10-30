import { Agent, AgentId, RuntimeModel, RuntimeModels, starterRole } from "@hobbots/domain";
import { describe, expect, it } from "vitest";
import { firstHobPayload, newDraft } from "./first-hob.ts";
import {
  aboutLine,
  goodAt,
  isDirty,
  pickRole,
  profileDraft,
  profileEdit,
  rebaseDraft,
  retiredSummary,
  roleProblem,
  roleRewrite,
} from "./profile.ts";

const model = (id: string, displayName: string, efforts: RuntimeModel["efforts"]) =>
  new RuntimeModel({ id, displayName, description: "", efforts, main: true });

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
      role: null,
      roleTitle: "Writer",
      sigil: "assistant",
      hat: null,
      tool: null,
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
    expect(rebased).toMatchObject({ instructions: "Write long answers.", model: "opus", effort: "high" });
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

  it("rewrites the opening Hobbots wrote when the role changes, and keeps the rest", () => {
    const writer = (instructions: string) => profileDraft(hob({ role: "writer", instructions }));
    const saved = writer(
      `You are Pip, a hob in Hobbots. Your role is Writer: ${starterRole("writer").note.toLowerCase()}\n\nBe brief.`,
    );
    const qaLine = `You are Pip, a hob in Hobbots. Your role is QA engineer: ${starterRole("qa").note.toLowerCase()}`;
    expect(roleRewrite("Pip", saved)).toBeUndefined();
    expect(roleRewrite("Pip", pickRole(saved, "qa"))).toBe(`${qaLine}\n\nBe brief.`);
    // A title in the user's own words, there and back.
    const own = { ...pickRole(saved, null), roleTitle: "Bug hunter " };
    expect(roleRewrite("Pip", own)).toBe("You are Pip, a hob in Hobbots. Your role is Bug hunter.\n\nBe brief.");
    const ownSaved = { ...own, instructions: roleRewrite("Pip", own) ?? "" };
    expect(roleRewrite("Pip", ownSaved)).toBeUndefined();
    expect(roleRewrite("Pip", pickRole(ownSaved, "qa"))).toBe(`${qaLine}\n\nBe brief.`);
    // No offer while the title is empty.
    expect(roleRewrite("Pip", { ...pickRole(saved, null), roleTitle: " " })).toBeUndefined();
  });

  it("keeps what the user wrote on the opening line", () => {
    // Text added after the opening stays.
    const added = profileDraft(
      hob({
        role: "writer",
        instructions: `You are Pip, a hob in Hobbots. Your role is Writer: ${starterRole("writer").note.toLowerCase()} Always ask before deleting files.`,
      }),
    );
    expect(roleRewrite("Pip", pickRole(added, "qa"))).toBe(
      `You are Pip, a hob in Hobbots. Your role is QA engineer: ${starterRole("qa").note.toLowerCase()} Always ask before deleting files.`,
    );
    const ownAdded = profileDraft(
      hob({
        role: null,
        roleTitle: "Bug hunter",
        instructions: "You are Pip, a hob in Hobbots. Your role is Bug hunter. Be kind.",
      }),
    );
    expect(roleRewrite("Pip", pickRole(ownAdded, "qa"))).toBe(
      `You are Pip, a hob in Hobbots. Your role is QA engineer: ${starterRole("qa").note.toLowerCase()} Be kind.`,
    );
    // An opening the user rewrote, or instructions of their own, get no offer.
    for (const instructions of [
      "You are Pip, a hob in Hobbots. Always ask before deleting files.",
      `You are Pip, a hob in Hobbots. Your role is Writer: ${starterRole("writer").note.toLowerCase().slice(0, -1)}, mostly emails.`,
      "Write short answers.",
    ]) {
      expect(roleRewrite("Pip", pickRole(profileDraft(hob({ role: "writer", instructions })), "qa"))).toBeUndefined();
    }
  });

  it("offers the rewrite whenever the opening names another role, even the saved one's way back", () => {
    // Assistant, then Writer with the rewrite taken, then back to Assistant before saving.
    const assistantLine = `You are Pip, a hob in Hobbots. Your role is Assistant: ${starterRole("assistant").note.toLowerCase()}`;
    const saved = profileDraft(hob({ role: "assistant", roleTitle: "Assistant", instructions: assistantLine }));
    const writer = pickRole(saved, "writer");
    const rewritten = { ...writer, instructions: roleRewrite("Pip", writer) ?? "" };
    expect(rewritten.instructions).toMatch(/^You are Pip, a hob in Hobbots\. Your role is Writer: /);
    const back = pickRole(rewritten, "assistant");
    expect(roleRewrite("Pip", back)).toBe(assistantLine);
  });

  it("sums up where the hob works, when it was summoned and its version", () => {
    expect(aboutLine(hob({ configVersion: 3 }))).toMatch(/^Works on the hub · Summoned Oct \d+ · Version 3$/);
  });

  it("says what retiring did with the hob's work", () => {
    expect(retiredSummary("Pip", "stop", false)).toBe("Pip is asleep. Its threads are kept and stay readable.");
    expect(retiredSummary("Pip", "finish", true)).toMatch(/^Pip finishes the replies/);
    expect(retiredSummary("Pip", "stop", true)).toMatch(/^Pip's running replies were stopped/);
  });

  it("takes a starter role with its title, sigil, hat and tool, as one edit", () => {
    const pip = hob();
    const draft = pickRole(profileDraft(pip, offered), "qa");
    expect(profileEdit(pip, draft)).toEqual({
      role: "qa",
      roleTitle: "QA engineer",
      sigil: "qa",
      hat: "horned",
      tool: "lantern",
    });
  });

  it("keeps the title, sigil, hat and tool when switching to the user's own words", () => {
    const qa = hob({ role: "qa", roleTitle: "QA engineer", sigil: "qa", hat: "horned", tool: "lantern" });
    const own = pickRole(profileDraft(qa, offered), null);
    expect(profileEdit(qa, own)).toEqual({ role: null });
    expect(profileEdit(qa, { ...own, roleTitle: "  Bug hunter " })).toEqual({ role: null, roleTitle: "Bug hunter" });
    expect(roleProblem({ ...own, roleTitle: "  " })).toBe("Give the role a title.");
    expect(roleProblem(own)).toBeUndefined();
  });

  it("keeps a role picked here when another window saves a new version", () => {
    const before = hob();
    const base = profileDraft(before, offered);
    const draft = pickRole(base, "qa");
    const after = hob({ instructions: "Be brief.", configVersion: 2 });
    const rebased = rebaseDraft(base, profileDraft(after, offered), draft);
    expect(rebased).toMatchObject({ role: "qa", roleTitle: "QA engineer", instructions: "Be brief." });
    expect(isDirty(base, draft)).toBe(true);
  });

  it("says what the hob is good at from its chores, else from its starter role", () => {
    const summoned = firstHobPayload({ ...newDraft(), name: "Pip", chores: "Sort my inbox.\nDraft replies." });
    expect(goodAt({ instructions: summoned.instructions, role: null })).toBe("Sort my inbox. Draft replies.");
    expect(goodAt({ instructions: "Be brief.", role: "qa" })).toMatch(/\S/);
    expect(goodAt({ instructions: "Be brief.", role: null })).toBeUndefined();
  });
});
