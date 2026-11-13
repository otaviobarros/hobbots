import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  type Actor,
  IllegalMemberTransition,
  type MemberEvent,
  MemberMachine,
  type MemberState,
  MemberState as MemberStates,
  planMemberAdd,
  ThreadId,
  ThreadMember,
  ThreadMembers,
} from "../src/index.ts";
import { agreesWithModel } from "../testing/machine-model.ts";

// Issue #1453 (ADR 039, Members): a member is active, left or removed, and a direct message takes no
// one but its person and its hob.

const at = "2026-11-13T10:00:00.000Z";

const member = (state: MemberState, actor: Actor = { kind: "hob", id: "aldric" }) =>
  new ThreadMember({
    threadId: ThreadId.make("camp"),
    actor,
    role: actor.kind === "user" ? "owner" : "member",
    state,
    joinedAt: at,
    addedBy: { kind: "user", id: "owner" },
    readRevision: null,
    mutedUntil: null,
    revision: 1,
  });

// The rules of ADR 039, written apart from the machine so the two can disagree: only an active
// member leaves or is removed, and one that left or was removed can come back.
const stepModel = (state: MemberState, e: MemberEvent): MemberState | "refused" => {
  switch (e._tag) {
    case "Leave":
      return state === "active" ? "left" : "refused";
    case "Remove":
      return state === "active" ? "removed" : "refused";
    case "Return":
      return state === "active" ? "refused" : "active";
  }
};

/** Everything a rule writes is the state; the rest of the member must stay as it was. */
const view = (m: ThreadMember) => m.state;

const events: fc.Arbitrary<MemberEvent> = fc.constantFrom<MemberEvent>(
  { _tag: "Leave" },
  { _tag: "Remove" },
  { _tag: "Return" },
);

describe("MemberMachine", () => {
  // covers ADR 039 (Members)
  it("[TC-DM-1453-01] agrees with a model of leave, remove and return over random runs of events", () => {
    agreesWithModel({
      machine: MemberMachine,
      records: fc.constantFrom(...MemberStates.literals).map((state) => member(state)),
      events,
      model: { init: view, step: stepModel, view },
      isError: (result): result is IllegalMemberTransition => result instanceof IllegalMemberTransition,
    });
  });

  // covers ADR 039 (Members)
  it("[TC-DM-1453-02] changes only the state, and names the member it refuses", () => {
    const left = ThreadMembers.transition(member("active"), { _tag: "Leave" });
    expect(left).toEqual(new ThreadMember({ ...member("active"), state: "left" }));
    const refused = ThreadMembers.transition(member("left"), { _tag: "Remove" });
    expect(refused).toBeInstanceOf(IllegalMemberTransition);
    expect(refused).toMatchObject({ from: "left", to: "removed", actor: { kind: "hob", id: "aldric" } });
    expect(MemberMachine.table.map((row) => [row.event, row.from, row.to])).toEqual([
      ["Leave", ["active"], "left"],
      ["Remove", ["active"], "removed"],
      ["Return", ["left", "removed"], "active"],
    ]);
  });
});

describe("planMemberAdd", () => {
  const owner = member("active", { kind: "user", id: "owner" });
  const hob = member("active");
  const rook = { kind: "hob" as const, id: "rook" };

  // covers ADR 039 (Members)
  it("[TC-DM-1453-03] refuses a third member in a direct message, and lets its own two come back", () => {
    expect(planMemberAdd({ kind: "chat" }, [owner, hob], rook)).toEqual({ _tag: "refused", reason: "direct-message" });
    expect(planMemberAdd({ kind: "chat" }, [owner, hob], hob.actor)).toEqual({ _tag: "active", member: hob });
    const away = member("left");
    expect(planMemberAdd({ kind: "chat" }, [owner, away], away.actor)).toEqual({ _tag: "return", member: away });
  });

  // covers ADR 039 (Members)
  it("[TC-DM-1453-04] adds anyone new to a camp, and brings back one who was removed", () => {
    expect(planMemberAdd({ kind: "camp" }, [owner, hob], rook)).toEqual({ _tag: "add" });
    const removed = member("removed", rook);
    expect(planMemberAdd({ kind: "camp" }, [owner, hob, removed], rook)).toEqual({ _tag: "return", member: removed });
  });
});
