import { describe, expect, it } from "vitest";
import { kindLine } from "./first-hob.ts";
import { newSummonDraft, pickKind, sampleChores, summonPayload } from "./summon.ts";

const id = "8a1f6c2e-3b4d-4e5f-9a6b-7c8d9e0f1a2b";
const fresh = (taken: ReadonlyArray<string> = []) =>
  newSummonDraft(
    taken,
    () => 0.5,
    () => id,
  );

describe("a summoned hob's draft", () => {
  it("starts as a helper with sample chores and a name no other hob has", () => {
    expect(fresh()).toMatchObject({ id, kind: "helper", name: "Pip", chores: sampleChores("helper") });
    const named = fresh(["Pip", " pip "]);
    expect(named.name).not.toBe("Pip");
    expect(named.name.trim()).not.toBe("");
  });

  it("brings a kind's name and chores until the user writes their own", () => {
    const scribe = pickKind(fresh(), "scribe");
    expect(scribe).toMatchObject({ name: "Quill", chores: sampleChores("scribe") });

    const edited = pickKind({ ...fresh(), chores: "Water the plants.", choresEdited: true, named: true }, "coder");
    expect(edited).toMatchObject({ kind: "coder", name: "Pip", chores: "Water the plants." });
  });

  it("adds the chores to the instructions and leaves them out when blank", () => {
    const payload = summonPayload({ ...pickKind(fresh(), "coder"), chores: "  Run the tests.  " });
    expect(payload).toMatchObject({ id, name: "Tinker", craft: "Coder", runtime: "claude-code" });
    expect(payload.instructions).toMatch(/^You are Tinker, a hob in Hobbots\. Your craft is Coder: /);
    expect(payload.instructions.endsWith("Your chores, in the user's words:\nRun the tests.")).toBe(true);

    expect(summonPayload({ ...fresh(), chores: " " }).instructions).not.toContain("chores");
  });

  it("names the kind after the hob's name", () => {
    expect(kindLine(pickKind(fresh(), "keeper"))).toBe("the Bookkeeper");
    expect(kindLine({ ...fresh(), kind: "custom", craft: "Gardening" })).toBe("good at gardening");
    expect(kindLine({ ...fresh(), kind: "custom", craft: " " })).toBe("one of a kind");
  });
});
