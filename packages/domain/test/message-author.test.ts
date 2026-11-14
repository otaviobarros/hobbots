import { describe, expect, it } from "vitest";
import { type Actor, AgentId, authorOf, Message, MessageId, replyHobOf, ThreadId } from "../src/index.ts";

// Issue #1549 (ADR 039, A member hob works as itself; STD-ARCH-021): a message's author is its
// actor, and only a message not stored yet falls back to the hob the thread belongs to.

const CAMP = { agentId: AgentId.make("wren") };
const QUILL: Actor = { kind: "hob", id: "quill" };
const LEO: Actor = { kind: "user", id: "leo" };

const message = (role: "user" | "assistant" | "note", actor: Actor | null) =>
  new Message({
    id: MessageId.make(`${role}-${actor?.id ?? "none"}`),
    threadId: ThreadId.make("camp"),
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
  it("[TC-CH-1549-01] names a member's reply as the member's, never the hob the camp belongs to", () => {
    expect(authorOf(message("assistant", QUILL), CAMP)).toEqual(QUILL);
    expect(replyHobOf(message("assistant", QUILL), CAMP)).toBe("quill");
    expect(authorOf(message("user", LEO), CAMP)).toEqual(LEO);
  });

  it("[TC-CH-1549-02] gives a reply with no author the camp's hob, a person's message none, and a person no reply hob", () => {
    expect(authorOf(message("assistant", null), CAMP)).toEqual({ kind: "hob", id: "wren" });
    expect(replyHobOf(message("assistant", null), CAMP)).toBe("wren");
    expect(authorOf(message("user", null), CAMP)).toBeNull();
    expect(replyHobOf(message("user", LEO), CAMP)).toBeNull();
    expect(replyHobOf(message("note", LEO), CAMP)).toBeNull();
  });
});
