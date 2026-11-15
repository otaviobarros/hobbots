import { AgentId, ChapterId, MessageId, Thread, ThreadId } from "@hobbots/domain";
import { Effect, Option } from "effect";
import { describe, expect, it } from "vitest";
import { makeTurnSession } from "../src/turn-session.ts";

const NOW = "2026-11-15T01:00:00.000Z";
const FRODO = AgentId.make("frodo");
const MARK = { since: NOW, source: 'the web search "lamp oil"' };

/** A turn session over a thread kept in memory, with every change the thread takes. */
const session = () => {
  let thread = new Thread({
    id: ThreadId.make("camp"),
    agentId: FRODO,
    title: "Lamps",
    kind: "camp",
    liveChapterId: ChapterId.make("chapter-1"),
    createdAt: NOW,
    updatedAt: NOW,
  });
  const changes: Array<Thread> = [];
  const turn = makeTurnSession({
    thread,
    runtime: "claude-code",
    agentId: FRODO,
    changeThread: (_, change) =>
      Effect.sync(() => {
        const next = change(thread);
        if (next === null) return Option.none();
        thread = next;
        changes.push(next);
        return Option.some(next);
      }),
    toldOfTask: () => null,
  });
  return { turn, changes };
};

describe("a turn's session as the thread records it", () => {
  // covers ADR 036 (The read-the-web mark), ADR 039 (Hobs talking to hobs)
  it("records a new session with the turn's read-the-web mark in the same change, and without one when it holds none", async () => {
    const marked = session();
    marked.turn.begin("s-1", null);
    await Effect.runPromise(marked.turn.record("s-1", MessageId.make("reply-1"), MARK));
    // One change writes the session already marked, so no reader or restart finds it unmarked.
    expect(marked.changes).toHaveLength(1);
    expect(marked.changes[0]?.sessions).toEqual([expect.objectContaining({ sessionId: "s-1", readWeb: MARK })]);

    const plain = session();
    plain.turn.begin("s-2", null);
    await Effect.runPromise(plain.turn.record("s-2", MessageId.make("reply-2"), null));
    expect(plain.changes).toHaveLength(1);
    expect(plain.changes[0]?.sessions[0]?.readWeb).toBeUndefined();
  });
});
