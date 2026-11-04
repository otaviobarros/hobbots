import { Message, MessageId, ThreadId } from "@hobbots/domain";
import { describe, expect, it } from "vitest";
import { findInChat } from "./chat-search-model.ts";

const message = (id: string, content: string, role: Message["role"] = "assistant") =>
  new Message({
    id: MessageId.make(id),
    threadId: ThreadId.make("t1"),
    role,
    content,
    status: "complete",
    error: null,
    configVersion: role === "user" ? null : 1,
    createdAt: "2026-11-04T09:00:00.000Z",
  });

const marked = (content: string, query: string) =>
  findInChat([message("m", content)], query)[0]
    ?.parts.map((part) => (part.match ? `[${part.text}]` : part.text))
    .join("");

describe("searching this chat", () => {
  it("finds the messages that say it, ignoring case, in the order they were sent", () => {
    const transcript = [
      message("a", "Lead with 20% off everything", "user"),
      message("b", "Nothing about prices here"),
      message("c", "The headline leads with 20% OFF"),
    ];
    expect(findInChat(transcript, "20% off").map((hit) => hit.message.id)).toEqual(["a", "c"]);
  });

  it("finds nothing until the query has two letters", () => {
    const transcript = [message("a", "a banner")];
    expect(findInChat(transcript, "a")).toEqual([]);
    expect(findInChat(transcript, "  ")).toEqual([]);
    expect(findInChat(transcript, " ba ")).toHaveLength(1);
  });

  it("marks the first match, keeping its case, with a line around it", () => {
    expect(marked("Ship the Banner today", "banner")).toBe("Ship the [Banner] today");
    const long = `${"x".repeat(50)} cutoff ${"y".repeat(80)}`;
    expect(marked(long, "cutoff")).toBe(`…${"x".repeat(33)} [cutoff] ${"y".repeat(59)}…`);
  });
});
