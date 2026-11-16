import { MessageId } from "@hobbots/domain";
import { afterEach, describe, expect, it } from "vitest";
import { replyKey, settleReply } from "./pending-reply.ts";

// Issue #1484 (ADR 039, Reply threads; ADR 016): a reply sent without an answer keeps its key outside
// the thread's box, so sending the same reply again, after a reload too, writes it once.

const ROOT = MessageId.make("ask");

afterEach(() => settleReply(ROOT));

describe("the key of a reply in a thread (#1484)", () => {
  it("is kept for the same reply until it settles, and new for another reply or after", () => {
    const first = replyKey(ROOT, { content: "I can, after 2.", alsoInMainLine: false });
    expect(replyKey(ROOT, { content: "I can, after 2.", alsoInMainLine: false })).toBe(first);
    // Also sent to the main line, it is another reply.
    const also = replyKey(ROOT, { content: "I can, after 2.", alsoInMainLine: true });
    expect(also).not.toBe(first);
    settleReply(ROOT);
    expect(replyKey(ROOT, { content: "I can, after 2.", alsoInMainLine: true })).not.toBe(also);
  });
});
