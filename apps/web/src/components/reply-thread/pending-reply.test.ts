import { MessageId } from "@hobbots/domain";
import { afterEach, describe, expect, it, vi } from "vitest";
import { replyKey, settleReply } from "./pending-reply.ts";

// Issue #1484 (ADR 039, Reply threads; ADR 016): a reply sent without an answer keeps its key outside
// the thread's box, so sending the same reply again, after a reload too, writes it once.

const ROOT = MessageId.make("ask");

afterEach(() => {
  settleReply(ROOT);
  vi.unstubAllGlobals();
});

/** Browser storage holding `entries`, as another build or window may have left it. */
const storageWith = (entries: Record<string, string>) => {
  const items = new Map(Object.entries(entries));
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => items.set(key, value),
    removeItem: (key: string) => items.delete(key),
  });
  return items;
};

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

  // covers STD-REACT-026
  it("reuses a stored key in the current shape, and drops one in any other shape", () => {
    const key = MessageId.make("kept-key");
    storageWith({
      "thread-reply.ask": JSON.stringify({ v: 1, key, content: "I can, after 2.", alsoInMainLine: false }),
    });
    expect(replyKey(ROOT, { content: "I can, after 2.", alsoInMainLine: false })).toBe(key);
    settleReply(ROOT);

    const items = storageWith({
      "thread-reply.ask": JSON.stringify({ key, content: "I can, after 2.", alsoInMainLine: false }),
    });
    expect(replyKey(ROOT, { content: "I can, after 2.", alsoInMainLine: false })).not.toBe(key);
    expect(JSON.parse(items.get("thread-reply.ask") ?? "null")).toMatchObject({ v: 1 });
  });
});
