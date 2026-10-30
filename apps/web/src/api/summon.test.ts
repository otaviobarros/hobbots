import { RuntimeHealth } from "@hobbots/domain";
import { describe, expect, it } from "vitest";
import { firstHobPayload, kindLine, pickCraft, sampleChores, submitDraft } from "./first-hob.ts";
import { newSummonDraft, openSummonDraft, providerNotice, summonProblem } from "./summon.ts";

const id = "8a1f6c2e-3b4d-4e5f-9a6b-7c8d9e0f1a2b";
const fresh = (taken: ReadonlyArray<string> = []) =>
  newSummonDraft(
    taken,
    () => 0.5,
    () => id,
  );

describe("a summoned hob's draft", () => {
  it("comes back as the user left it, unless its hob already joined", () => {
    const left = { ...fresh(), name: "Moss", chores: "Water the plants.", choresEdited: true };
    expect(openSummonDraft(left, [{ id: "other", name: "Pip" }])).toEqual(left);
    expect(openSummonDraft(left, [{ id, name: "Moss" }]).id).not.toBe(id);
    expect(openSummonDraft(null, [{ id: "other", name: "Pip" }]).name).not.toBe("Pip");
  });

  it("starts as a helper with sample chores and a name no other hob has", () => {
    expect(fresh()).toMatchObject({ id, kind: "helper", name: "Pip", chores: sampleChores("helper") });
    const named = fresh(["Pip", " pip "]);
    expect(named.name).not.toBe("Pip");
    expect(named.name.trim()).not.toBe("");
  });

  it("brings a kind's name and chores until the user writes their own", () => {
    const scribe = pickCraft(fresh(), "scribe");
    expect(scribe).toMatchObject({ name: "Quill", chores: sampleChores("scribe") });

    const edited = pickCraft({ ...fresh(), chores: "Water the plants.", choresEdited: true, named: true }, "coder");
    expect(edited).toMatchObject({ kind: "coder", name: "Pip", chores: "Water the plants." });
  });

  it("adds the chores to the instructions and leaves them out when blank", () => {
    const payload = firstHobPayload({ ...pickCraft(fresh(), "coder"), chores: "  Run the tests.  " });
    expect(payload).toMatchObject({ id, name: "Tinker", craft: "Coder", runtime: "claude-code" });
    expect(payload.instructions).toMatch(/^You are Tinker, a hob in Hobbots\. Your craft is Coder: /);
    expect(payload.instructions.endsWith("Your chores, in the user's words:\nRun the tests.")).toBe(true);

    expect(firstHobPayload({ ...fresh(), chores: " " }).instructions).not.toContain("chores");
  });

  it("names the kind after the hob's name", () => {
    expect(kindLine(pickCraft(fresh(), "keeper"))).toBe("the Bookkeeper");
    expect(kindLine({ ...fresh(), kind: "custom", craft: "Gardening" })).toBe("good at gardening");
    expect(kindLine({ ...fresh(), kind: "custom", craft: " " })).toBe("one of a kind");
  });
});

const health = (availability: RuntimeHealth["availability"], version: string | null = "2.1.301") =>
  new RuntimeHealth({ runtime: "claude-code", availability, billing: null, version, detail: null, checkedAt: null });

describe("the provider a summoned hob thinks with", () => {
  it("is offered only when Claude Code is ready", () => {
    expect(providerNotice(health("ready"))).toBeUndefined();
    expect(providerNotice(undefined)).toBe("Claude Code is not connected.");
  });

  it("says how to fix a provider that lists models but cannot run a chat", () => {
    expect(providerNotice(health("signedOut"))).toMatch(/not signed in/);
    expect(providerNotice(health("outdated"))).toMatch(/claude update/);
    expect(providerNotice(health("unavailable", null))).toMatch(/not found/);
    expect(providerNotice(health("unverified"))).toMatch(/could not confirm/);
  });
});

describe("what stops a summon", () => {
  const checked = (availability: RuntimeHealth["availability"]) => ({
    pending: false,
    failed: false,
    health: health(availability),
  });

  it("goes once Claude Code is confirmed ready and a model is picked", () => {
    expect(summonProblem(fresh(), checked("ready"), true)).toBeUndefined();
    expect(summonProblem(fresh(), checked("ready"), false)).toBe("Waiting for Claude Code's models");
  });

  it("waits for Claude Code's health even when the models already loaded", () => {
    expect(summonProblem(fresh(), { pending: true, failed: false, health: undefined }, true)).toBe(
      "Checking Claude Code",
    );
    expect(summonProblem(fresh(), { pending: false, failed: true, health: undefined }, true)).toBe(
      "Check Claude Code again to summon Pip",
    );
    expect(summonProblem(fresh(), checked("signedOut"), true)).toBe("Fix Claude Code in Settings to summon Pip");
  });

  it("keeps the last health it saw when checking again fails", () => {
    expect(summonProblem(fresh(), { pending: false, failed: true, health: health("ready") }, true)).toBeUndefined();
  });

  it("lets a sent summon be retried, since the hub may already have made the hob", () => {
    const sent = submitDraft(fresh());
    expect(summonProblem(sent, { pending: false, failed: true, health: undefined }, false)).toBeUndefined();
  });
});
