import { type Actor, Agent, AgentId, Message, MessageId, ChannelId } from "@hobbots/domain";
import { describe, expect, it } from "vitest";
import { replyAuthor } from "./reply-author.ts";

const hob = (id: string, name: string) =>
  new Agent({
    id: AgentId.make(id),
    name,
    roleTitle: "Writer",
    runtime: "claude-code",
    model: null,
    effort: null,
    instructions: "",
    lookSeed: 1,
    lookColor: "moss",
    configVersion: 1,
    createdAt: "2026-11-01T00:00:00.000Z",
  });
const sam = hob("sam", "Sam");
const frodo = hob("frodo", "Frodo");

const reply = (role: "user" | "assistant", actor: Actor | null) =>
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
    revision: 1,
  });

describe("who wrote a reply", () => {
  // covers ADR 039 (A member hob works as itself)
  it("shows a member's reply in a camp as the member's, and an older reply as the camp's hob's (#1461)", () => {
    expect(replyAuthor(reply("assistant", { kind: "hob", id: "frodo" }), sam, [sam, frodo])).toBe(frodo);
    expect(replyAuthor(reply("assistant", { kind: "hob", id: "sam" }), sam, [sam, frodo])).toBe(sam);
    expect(replyAuthor(reply("assistant", null), sam, [sam, frodo])).toBe(sam);
    // A hob no longer listed, or the list not loaded yet, shows as the camp's own hob.
    expect(replyAuthor(reply("assistant", { kind: "hob", id: "gone" }), sam, [sam])).toBe(sam);
    expect(replyAuthor(reply("assistant", { kind: "hob", id: "frodo" }), sam, undefined)).toBe(sam);
    // Your messages keep the channel's hob, whose chat they are in.
    expect(replyAuthor(reply("user", { kind: "user", id: "owner" }), sam, [sam, frodo])).toBe(sam);
  });
});
