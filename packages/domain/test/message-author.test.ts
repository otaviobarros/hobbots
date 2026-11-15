import { describe, expect, it } from "vitest";
import { type Actor, AgentId, authorOf, ChannelId, Message, MessageId, replyHobOf } from "../src/index.ts";

// Issue #1549 (ADR 039, A member hob works as itself; STD-ARCH-021): a message's author is its
// actor, and only a message not stored yet falls back to the hob the channel belongs to.

const CAMP = { ownerHobId: AgentId.make("wren") };
const QUILL: Actor = { kind: "hob", id: "quill" };
const LEO: Actor = { kind: "user", id: "leo" };

const message = (role: "user" | "assistant" | "note", actor: Actor | null) =>
  new Message({
    id: MessageId.make(`${role}-${actor?.id ?? "none"}`),
    channelId: ChannelId.make("camp"),
    actor,
    role,
    content: "Hello",
    status: "complete",
    error: null,
    configVersion: null,
    createdAt: "2026-11-14T00:00:00.000Z",
  });

describe("who wrote a message", () => {
  // covers ADR 039 (A member hob works as itself)
  it("names a member's reply as the member's, never the hob the camp belongs to (#1549)", () => {
    expect(authorOf(message("assistant", QUILL), CAMP)).toEqual(QUILL);
    expect(replyHobOf(message("assistant", QUILL), CAMP)).toBe("quill");
    expect(authorOf(message("user", LEO), CAMP)).toEqual(LEO);
  });

  it("gives a reply with no author the camp's hob, a person's message none, and a person no reply hob (#1549)", () => {
    expect(authorOf(message("assistant", null), CAMP)).toEqual({ kind: "hob", id: "wren" });
    expect(replyHobOf(message("assistant", null), CAMP)).toBe("wren");
    expect(authorOf(message("user", null), CAMP)).toBeNull();
    expect(replyHobOf(message("user", LEO), CAMP)).toBeNull();
    expect(replyHobOf(message("note", LEO), CAMP)).toBeNull();
  });
});
