import { describe, expect, it } from "vitest";
import { firstHobPayload, newDraft, pickRole } from "../../api/first-hob.ts";
import { messages } from "./messages.ts";
import {
  gearHint,
  lookChoices,
  parseStep,
  roleProblem,
  startersFor,
  stepAt,
  summoningLeft,
  typeOwnTitle,
} from "./summon-model.ts";

const draft = () =>
  newDraft(
    () => 0.5,
    () => "8a1f6c2e-3b4d-4e5f-9a6b-7c8d9e0f1a2b",
  );

describe("Summon's steps", () => {
  it("reads the step from the address, and falls back to the first", () => {
    expect(parseStep("look")).toBe("look");
    expect(parseStep("ready")).toBe("ready");
    expect(parseStep("arrived")).toBe("role");
    expect(parseStep(undefined)).toBe("role");
  });

  it("stays inside the three steps", () => {
    expect(stepAt(-1)).toBe("role");
    expect(stepAt(1)).toBe("look");
    expect(stepAt(5)).toBe("ready");
  });

  it("holds the first step until a title of your own has words", () => {
    expect(roleProblem(draft())).toBeUndefined();
    expect(roleProblem(typeOwnTitle(draft(), "  "))).toBeDefined();
    expect(roleProblem(typeOwnTitle(draft(), "Garden planner"))).toBeUndefined();
  });
});

describe("a title of your own", () => {
  it("replaces the role and gives the hat and tool back to the look", () => {
    const writer = pickRole(draft(), "writer");
    const own = typeOwnTitle(writer, "Garden planner");
    expect(own).toMatchObject({ role: null, ownTitle: "Garden planner", hat: null, tool: null });
    // Sample chores belong to the role, so they go with it; chores the user wrote stay.
    expect(own.chores).toBe("");
    expect(typeOwnTitle({ ...writer, chores: "Mine", choresEdited: true }, "Garden").chores).toBe("Mine");
  });

  it("keeps the gear the user chose while they keep typing", () => {
    const own = { ...typeOwnTitle(draft(), "Garden"), hat: "crown" as const };
    expect(typeOwnTitle(own, "Garden planner").hat).toBe("crown");
  });
});

describe("the Look step", () => {
  it("offers the set's own look first, then four near it", () => {
    const looks = lookChoices(draft());
    expect(looks).toHaveLength(5);
    expect(looks[0]).toBe(draft().lookBase);
    expect(new Set(looks).size).toBe(5);
  });

  it("says where the hat and tool came from", () => {
    expect(gearHint(pickRole(draft(), "writer"))).toBe(
      "The Writer role starts with the pointy hat and the quill. Change either one.",
    );
    expect(gearHint(typeOwnTitle(draft(), "Garden planner"))).toMatch(/^The look picks/);
  });
});

describe("how a summoned hob talks", () => {
  it("is sent only when it differs from Hobbots' defaults", () => {
    expect(firstHobPayload(draft())).not.toHaveProperty("voice");
    expect(firstHobPayload({ ...draft(), voice: "friendly", length: "brief" })).toMatchObject({
      voice: "friendly",
      length: "brief",
    });
  });
});

describe("the Arrived screen", () => {
  it("offers a role's own first questions, then its family's, then a general set", () => {
    expect(startersFor("writer")[0]).toBe("Turn these bullet points into a friendly email");
    expect(startersFor("frontend")).toEqual(messages.arrived.starters.software);
    expect(startersFor(null)).toEqual(messages.arrived.starters.own);
    expect(startersFor("chef")).toHaveLength(3);
  });

  it("plays the summoning out, and skips it under Reduce motion", () => {
    expect(summoningLeft(1000, 1500, 2600, false)).toBe(2100);
    expect(summoningLeft(1000, 5000, 2600, false)).toBe(0);
    expect(summoningLeft(1000, 1500, 2600, true)).toBe(0);
  });
});
