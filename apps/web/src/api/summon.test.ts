import { RuntimeHealth, type RuntimeKind, RuntimeModel, RuntimeModels } from "@hobbots/domain";
import { describe, expect, it } from "vitest";
import { readyProviders } from "../lib/providers.ts";
import { enforcementFixture } from "../test/enforcement.ts";
import {
  firstHobPayload,
  kindLine,
  pickRole,
  pickRuntime,
  sampleChores,
  settleBrain,
  settleRuntime,
  submitDraft,
} from "./first-hob.ts";
import { newSummonDraft, openSummonDraft, summonProblem } from "./summon.ts";

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

  it("starts as an Assistant with sample chores and a name no other hob has", () => {
    expect(fresh()).toMatchObject({ id, role: "assistant", name: "Pip", chores: sampleChores("assistant") });
    const named = fresh(["Pip", " pip "]);
    expect(named.name).not.toBe("Pip");
    expect(named.name.trim()).not.toBe("");
  });

  it("brings a role's chores until the user writes their own, and keeps the name", () => {
    const writer = pickRole(fresh(), "writer");
    expect(writer).toMatchObject({ name: "Pip", chores: sampleChores("writer") });

    const edited = pickRole({ ...fresh(), chores: "Water the plants.", choresEdited: true }, "engineer");
    expect(edited).toMatchObject({ role: "engineer", name: "Pip", chores: "Water the plants." });
  });

  it("adds the chores to the instructions and leaves them out when blank", () => {
    const payload = firstHobPayload({ ...pickRole(fresh(), "engineer"), name: "Tinker", chores: "  Run the tests.  " });
    expect(payload).toMatchObject({ id, name: "Tinker", roleTitle: "Software engineer", runtime: "claude-code" });
    // The hub tells the runtime the hob's name and role, so the instructions hold only the chores.
    expect(payload.instructions).toBe("Your chores, in the user's words:\nRun the tests.");

    expect(firstHobPayload({ ...fresh(), chores: " " }).instructions).toBe("");
  });

  it("names the role after the hob's name", () => {
    expect(kindLine(pickRole(fresh(), "bookkeeper"))).toBe("the Bookkeeper");
    expect(kindLine({ ...pickRole(fresh(), null), ownTitle: "Garden planner" })).toBe("the Garden planner");
    expect(kindLine({ ...pickRole(fresh(), null), ownTitle: " " })).toBe("one of a kind");
  });
});

const health = (
  availability: RuntimeHealth["availability"],
  version: string | null = "2.1.301",
  runtime: RuntimeKind = "claude-code",
) =>
  new RuntimeHealth({
    runtime,
    availability,
    billing: null,
    version,
    detail: null,
    checkedAt: null,
    enforcement: enforcementFixture(),
  });

describe("the provider a summoned hob thinks with", () => {
  it("starts on Claude, and goes in the create request as picked", () => {
    expect(fresh().runtime).toBe("claude-code");
    expect(firstHobPayload(pickRuntime(fresh(), "codex")).runtime).toBe("codex");
  });

  it("leaves the model and effort to the new provider's own list", () => {
    const thinking = { ...fresh(), model: "sonnet", effort: "high" as const };
    expect(pickRuntime(thinking, "codex")).toMatchObject({ runtime: "codex", model: null, effort: null });
    expect(pickRuntime(thinking, "claude-code")).toBe(thinking);
  });

  it("moves an unsent draft to the first ready provider, and keeps its own when none is ready", () => {
    expect(settleRuntime(fresh(), ["codex"]).runtime).toBe("codex");
    expect(settleRuntime(fresh(), ["claude-code", "codex"]).runtime).toBe("claude-code");
    expect(settleRuntime(fresh(), []).runtime).toBe("claude-code");
    const sent = submitDraft(fresh());
    expect(settleRuntime(sent, ["codex"])).toBe(sent);
  });

  it("settles only against its own provider's models", () => {
    const codex = new RuntimeModels({
      runtime: "codex",
      source: "runtime",
      models: [new RuntimeModel({ id: "gpt-5", displayName: "GPT-5", description: "", efforts: ["low"], main: true })],
    });
    expect(settleBrain(fresh(), codex)).toEqual(fresh());
    expect(settleBrain(pickRuntime(fresh(), "codex"), codex)).toMatchObject({ model: "gpt-5", effort: "low" });
  });

  it("offers only the providers that are ready, in order, narrowed to the ones connected", () => {
    const runtimes = [health("signedOut", "0.166.0", "codex"), health("ready")];
    expect(readyProviders(runtimes)).toEqual(["claude-code"]);
    expect(readyProviders([health("ready", "0.166.0", "codex"), health("ready")])).toEqual(["claude-code", "codex"]);
    expect(readyProviders([health("ready", "0.166.0", "codex"), health("ready")], ["codex"])).toEqual(["codex"]);
    expect(readyProviders(undefined)).toEqual([]);
  });
});

describe("what stops a summon", () => {
  const checked = (availability: RuntimeHealth["availability"]) => ({
    pending: false,
    failed: false,
    health: health(availability),
  });

  it("goes once the provider is confirmed ready and a model is picked", () => {
    expect(summonProblem(fresh(), checked("ready"), true)).toBeUndefined();
    expect(summonProblem(fresh(), checked("ready"), false)).toBe("Waiting for Claude Code's models");
    expect(summonProblem(pickRuntime(fresh(), "codex"), checked("ready"), false)).toBe("Waiting for Codex's models");
  });

  it("waits for the provider's health even when the models already loaded", () => {
    expect(summonProblem(fresh(), { pending: true, failed: false, health: undefined }, true)).toBe(
      "Checking your AI providers",
    );
    expect(summonProblem(fresh(), { pending: false, failed: true, health: undefined }, true)).toBe(
      "Check your AI providers again to summon Pip",
    );
    expect(summonProblem(fresh(), checked("signedOut"), true)).toBe("Fix a provider to summon Pip");
    expect(summonProblem(fresh(), checked("unavailable"), true)).toBe("Fix a provider to summon Pip");
  });

  it("keeps the last health it saw when checking again fails", () => {
    expect(summonProblem(fresh(), { pending: false, failed: true, health: health("ready") }, true)).toBeUndefined();
  });

  it("lets a sent summon be retried, since the hub may already have made the hob", () => {
    const sent = submitDraft(fresh());
    expect(summonProblem(sent, { pending: false, failed: true, health: undefined }, false)).toBeUndefined();
  });
});
