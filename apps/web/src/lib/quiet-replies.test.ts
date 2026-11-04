import { Message, MessageId, type MessageStatus, type ReplyStep, ThreadId } from "@hobbots/domain";
import { describe, expect, it } from "vitest";
import { isQuietReply } from "./quiet-replies.ts";

const message = (role: "user" | "assistant", content: string, status: MessageStatus = "complete") =>
  new Message({
    id: MessageId.make(`${role}-${content}`),
    threadId: ThreadId.make("chat"),
    role,
    content,
    status,
    error: null,
    configVersion: null,
    createdAt: "2026-11-04T00:00:00.000Z",
    revision: 1,
  });

describe("quiet replies", () => {
  const plan = message("assistant", "Quill drafts the copy, then Ada builds the page.");

  it("leaves out a lead's turn on arrived work that wrote nothing", () => {
    expect(isQuietReply(message("assistant", ""), plan)).toBe(true);
    expect(isQuietReply(message("assistant", "  \n"), message("assistant", ""))).toBe(true);
  });

  it("keeps a reply that says something, answers your message, or ended early", () => {
    expect(isQuietReply(message("assistant", "Done."), plan)).toBe(false);
    expect(isQuietReply(message("assistant", ""), message("user", "How is it going?"))).toBe(false);
    expect(isQuietReply(message("assistant", "", "interrupted"), plan)).toBe(false);
    expect(isQuietReply(message("assistant", "", "streaming"), plan)).toBe(false);
    expect(isQuietReply(message("assistant", ""), undefined)).toBe(false);
  });

  it("keeps a quiet reply whose tool call did not plainly succeed, so an uncertain write can be settled", () => {
    const step = (state: ReplyStep["state"]): ReplyStep => ({
      id: `t-${state}`,
      kind: "tool",
      label: "Pushing",
      state,
    });
    const quiet = (steps: ReadonlyArray<ReplyStep>) =>
      isQuietReply(new Message({ ...message("assistant", ""), steps: [...steps] }), plan);
    expect(quiet([step("done")])).toBe(true);
    expect(quiet([{ id: "thinking-1", kind: "thinking", label: "Thinking", state: "unfinished" }])).toBe(true);
    for (const state of ["uncertain", "failed", "denied", "unfinished"] as const) {
      expect(quiet([step("done"), step(state)])).toBe(false);
    }
  });
});
