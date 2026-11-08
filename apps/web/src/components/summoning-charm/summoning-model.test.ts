import {
  DEFAULT_SUMMONING_SCOPE,
  EMPTY_HOB_POLICY,
  type HobPolicy,
  SUMMONING_DEFAULTS,
  type SummoningForEveryHob,
} from "@hobbots/domain";
import { describe, expect, it } from "vitest";
import {
  everyHobEditPayload,
  everyHobSummoning,
  hobEditPayload,
  hobSummoning,
  hobSwitchPayload,
  pickHob,
  shownAnswer,
  shownGroups,
} from "./summoning-model.ts";

const everyHob: SummoningForEveryHob = {
  scope: { summoned: true, hobs: ["quill"], self: false },
  overrides: { ...SUMMONING_DEFAULTS, "summoning.name": "deny" },
};

const own: HobPolicy = {
  ...EMPTY_HOB_POLICY,
  charms: {
    granted: ["github", "summoning"],
    overrides: { "github.comment": "ask", "summoning.summon": "ask", "summoning.brain": "deny" },
    summoning: { summoned: true, hobs: [], self: false },
  },
};

const made = (policy: HobPolicy) => ({ policy, summonedBy: null });

describe("the Summoning Charm on a hob's Charms tab", () => {
  it("shows the hob's own grant, with Allow for every field it leaves alone", () => {
    const view = hobSummoning(made(own), everyHob);
    expect(view.held).toBe("own");
    expect(view.answers["summoning.summon"]).toBe("ask");
    expect(view.answers["summoning.brain"]).toBe("deny");
    expect(view.answers["summoning.name"]).toBe("allow");
    expect(view.scope).toEqual({ summoned: true, hobs: [], self: false });
  });

  it("shows Summoning for every hob on a hob you made, never on one a hob summoned or one you took it from", () => {
    expect(hobSummoning(made(EMPTY_HOB_POLICY), everyHob)).toMatchObject({
      held: "every-hob",
      scope: everyHob.scope,
      answers: { "summoning.name": "deny", "summoning.role": "ask" },
    });
    expect(hobSummoning({ policy: EMPTY_HOB_POLICY, summonedBy: "chief" }, everyHob).held).toBe("off");
    const withheld = { ...EMPTY_HOB_POLICY, charms: { withheld: ["summoning"] } };
    expect(hobSummoning(made(withheld), everyHob).held).toBe("off");
    expect(hobSummoning(made(EMPTY_HOB_POLICY), null).held).toBe("off");
  });

  it("changes an answer of the hob's own grant in place and keeps the other Charms' answers", () => {
    const view = hobSummoning(made(own), null);
    expect(hobEditPayload(own, view, { _tag: "Answer", operation: "summoning.brain", answer: "allow" })).toEqual({
      charms: { overrides: { "github.comment": "ask", "summoning.summon": "ask" } },
    });
    expect(hobEditPayload(own, view, { _tag: "Answer", operation: "summoning.name", answer: "ask" })).toEqual({
      charms: {
        overrides: {
          "github.comment": "ask",
          "summoning.summon": "ask",
          "summoning.brain": "deny",
          "summoning.name": "ask",
        },
      },
    });
  });

  it("narrows the hob's own scope in place", () => {
    const view = hobSummoning(made(own), null);
    expect(hobEditPayload(own, view, { _tag: "Scope", scope: { ...view.scope, summoned: false } })).toEqual({
      charms: { summoning: { summoned: false, hobs: [], self: false } },
    });
  });

  it("gives a hob that has it from every hob its own grant, every answer written out", () => {
    const view = hobSummoning(made(EMPTY_HOB_POLICY), everyHob);
    const payload = hobEditPayload(EMPTY_HOB_POLICY, view, {
      _tag: "Answer",
      operation: "summoning.summon",
      answer: "allow",
    });
    expect(payload.charms?.granted).toEqual(["github", "summoning"]);
    expect(payload.charms?.summoning).toEqual(everyHob.scope);
    // Allow is written out, so the defaults the hub writes on a grant never set it back to Ask.
    expect(payload.charms?.overrides).toMatchObject({
      "summoning.summon": "allow",
      "summoning.name": "deny",
      "summoning.role": "ask",
      "summoning.pause": "allow",
    });
  });

  it("takes it away from a hob, withholding what every hob gives so it does not come back", () => {
    expect(hobSwitchPayload(made(own), null, false)).toEqual({ charms: { granted: ["github"] } });
    expect(hobSwitchPayload(made(own), everyHob, false)).toEqual({
      charms: { granted: ["github"], withheld: ["summoning"] },
    });
    expect(hobSwitchPayload(made(EMPTY_HOB_POLICY), everyHob, false)).toEqual({
      charms: { granted: ["github"], withheld: ["summoning"] },
    });
  });

  it("gives it back from every hob when you took it away, and grants its own otherwise", () => {
    const withheld = { ...EMPTY_HOB_POLICY, charms: { withheld: ["summoning"] } };
    expect(hobSwitchPayload(made(withheld), everyHob, true)).toEqual({ charms: { withheld: [] } });
    expect(hobSwitchPayload(made(EMPTY_HOB_POLICY), null, true)).toEqual({
      charms: { withheld: [], granted: ["github", "summoning"] },
    });
    expect(hobSwitchPayload({ policy: EMPTY_HOB_POLICY, summonedBy: "chief" }, everyHob, true)).toEqual({
      charms: { withheld: [], granted: ["github", "summoning"] },
    });
  });

  it("shows the hob's own fields only while it may manage itself, and retiring's Ask as asking once", () => {
    expect(shownGroups(DEFAULT_SUMMONING_SCOPE).map((group) => group.id)).not.toContain("self");
    expect(shownGroups({ ...DEFAULT_SUMMONING_SCOPE, self: true }).map((group) => group.id)).toContain("self");
    const asked = hobSummoning(
      made({ ...own, charms: { ...own.charms, overrides: { "summoning.retire": "ask" } } }),
      null,
    );
    expect(shownAnswer(asked, "summoning.retire")).toBe("allow");
  });

  it("adds a picked hob once and takes it off again", () => {
    const scope = pickHob(pickHob(DEFAULT_SUMMONING_SCOPE, "quill", true), "quill", true);
    expect(scope.hobs).toEqual(["quill"]);
    expect(pickHob(scope, "quill", false).hobs).toEqual([]);
  });
});

describe("turning Can manage itself on", () => {
  const selfOn = (scope: {
    readonly summoned: boolean;
    readonly hobs: ReadonlyArray<string>;
    readonly self: boolean;
  }) => ({
    _tag: "Scope" as const,
    scope: { ...scope, self: true },
  });
  const selfAnswers: Record<string, "ask"> = {
    "summoning.self-name": "ask",
    "summoning.self-good-at": "ask",
    "summoning.self-look": "ask",
    "summoning.self-voice": "ask",
    "summoning.self-brain": "ask",
    "summoning.self-instructions": "ask",
  };

  it("asks for every self field when a hob gets its own grant from every hob", () => {
    const view = hobSummoning(made(EMPTY_HOB_POLICY), everyHob);
    expect(hobEditPayload(EMPTY_HOB_POLICY, view, selfOn(view.scope)).charms?.overrides).toMatchObject(selfAnswers);
  });

  it("asks for every self field in Summoning for every hob", () => {
    const view = everyHobSummoning(everyHob);
    expect(everyHobEditPayload(view, selfOn(view.scope)).overrides).toMatchObject(selfAnswers);
  });

  it("keeps self answers you set when the switch was already on", () => {
    const on: SummoningForEveryHob = {
      scope: { ...everyHob.scope, self: true },
      overrides: { ...everyHob.overrides, ...selfAnswers, "summoning.self-name": "allow" },
    };
    const view = everyHobSummoning(on);
    const sent = everyHobEditPayload(view, { _tag: "Scope", scope: { ...on.scope, summoned: false } });
    expect(sent.overrides["summoning.self-name"]).toBe("allow");
  });
});

describe("Summoning for every hob in Settings", () => {
  it("is off without the setting, and sends every answer written out", () => {
    expect(everyHobSummoning(null).held).toBe("off");
    const view = everyHobSummoning(everyHob);
    const sent = everyHobEditPayload(view, { _tag: "Answer", operation: "summoning.name", answer: "allow" });
    expect(sent.scope).toEqual(everyHob.scope);
    expect(sent.overrides).toMatchObject({ "summoning.name": "allow", "summoning.summon": "ask" });
    expect(everyHobEditPayload(view, { _tag: "Scope", scope: { ...view.scope, self: true } }).scope.self).toBe(true);
  });
});
