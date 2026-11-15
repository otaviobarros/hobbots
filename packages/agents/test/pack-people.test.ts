import { type Actor, AgentId, Message, MessageId, OWNER_ACTOR, Channel, ChannelId, ChannelMember } from "@hobbots/domain";
import { describe, expect, it } from "vitest";
import { buildBriefing } from "../src/briefing.ts";
import { reasonLine, type TurnReason, turnReasonOf } from "../src/pack-people.ts";

// Issue #1465 (ADR 039, The context pack with several hobs): why a hob's turn runs, as the floor
// decides it, and the line its pack says it with.

const NOW = "2026-11-14T00:00:00.000Z";
const CAMP = ChannelId.make("camp");
const WREN = AgentId.make("wren");
const QUILL = AgentId.make("quill");
const LEO: Actor = { kind: "user", id: "leo" };
const hob = (id: AgentId): Actor => ({ kind: "hob", id });

const member = (actor: Actor) =>
  new ChannelMember({
    channelId: CAMP,
    actor,
    role: actor.kind === "user" && actor.id === OWNER_ACTOR.id ? "owner" : "member",
    state: "active",
    joinedAt: NOW,
    addedBy: OWNER_ACTOR,
    readRevision: null,
    mutedUntil: null,
    revision: 1,
  });

const channel = new Channel({ id: CAMP, ownerHobId: WREN, title: "Market", kind: "camp", createdAt: NOW, updatedAt: NOW });

const said = (actor: Actor, mentions: ReadonlyArray<Actor> = []) =>
  new Message({
    id: MessageId.make("m1"),
    channelId: CAMP,
    actor,
    role: "user",
    content: "Can you check the dates?",
    status: "complete",
    error: null,
    configVersion: null,
    runtime: null,
    model: null,
    mentions: [...mentions],
    createdAt: NOW,
  });

const names = (actor: Actor) => ({ leo: "Leo", wren: "Wren", quill: "Quill" })[actor.id] ?? "Someone";

describe("why a turn runs", () => {
  // covers ADR 039 (The context pack with several hobs, Who answers)
  it("is the hob's own answer from the floor's rule, said in one line (#1465)", () => {
    const two = [member(OWNER_ACTOR), member(LEO), member(hob(WREN)), member(hob(QUILL))];
    const mentioned = turnReasonOf(said(LEO, [hob(WREN)]), channel, two, WREN);
    expect(mentioned).toEqual({ cause: "mention", by: LEO });
    expect(reasonLine(mentioned as TurnReason, names)).toBe("Leo mentioned you.");
    // Quill was not mentioned, so it owes no answer.
    expect(turnReasonOf(said(LEO, [hob(WREN)]), channel, two, QUILL)).toBeNull();

    const relayed = turnReasonOf(said(hob(QUILL), [hob(WREN)]), channel, two, WREN);
    expect(reasonLine(relayed as TurnReason, names)).toBe("Quill, another hob, mentioned you.");

    const alone = [member(OWNER_ACTOR), member(hob(WREN))];
    const only = turnReasonOf(said(OWNER_ACTOR), channel, alone, WREN);
    expect(only).toEqual({ cause: "only-hob", by: OWNER_ACTOR });
    expect(reasonLine(only as TurnReason, names)).toBe("You are the only hob here.");

    // A continuation has no prompt, and nobody is owed an answer in a camp of two hobs with no mention.
    expect(turnReasonOf(null, channel, alone, WREN)).toBeNull();
    expect(turnReasonOf(said(LEO), channel, two, WREN)).toBeNull();

    // With a Quest running in the camp, its lead answers what mentions nobody, as the floor decides.
    const quest = { leadId: QUILL, party: [] };
    const lead = turnReasonOf(said(LEO), channel, two, QUILL, quest);
    expect(lead).toEqual({ cause: "lead", by: LEO });
    expect(reasonLine(lead as TurnReason, names)).toBe(
      "You lead the quest running here, and nobody else was mentioned.",
    );
  });

  // covers ADR 039 (The context pack with several hobs), ADR 017
  it("a brain switch's briefing names each speaker when it is given names (#1465)", () => {
    const told = buildBriefing({
      kind: "resumed",
      messages: [said(LEO)],
      checkpoint: null,
      speaker: () => "Leo (person)",
    });
    expect(told?.text).toContain("**Leo (person):**\n> Can you check the dates?");
    expect(buildBriefing({ kind: "resumed", messages: [said(LEO)], checkpoint: null })?.text).toContain("**User:**");
  });
});
