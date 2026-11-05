import { type MemorySave, MessageId, ThreadId } from "@hobbots/domain";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { applyMemorySave, refreshMemorySaves, threadMemorySavesQuery } from "./memory-saves.ts";

const thread = ThreadId.make("thread-1");

/** A save of thread-1's reply, as the hub records it; `undoneAt` marks it undone. */
const save = (id: string, updatedAt = "2026-11-05T09:55:00.000Z", undoneAt?: string) =>
  ({
    id,
    threadId: thread,
    messageId: MessageId.make("reply-1"),
    state: "saved",
    updatedAt,
    ...(undoneAt === undefined ? {} : { undoneAt }),
  }) as unknown as MemorySave;

/**
 * A thread's saves on screen, whose reads answer only when the test says so, in order: `answer(n, …)`
 * settles the nth read with what the hub had when that read was taken.
 */
const watchedSaves = () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const pending: Array<(value: ReadonlyArray<MemorySave>) => void> = [];
  const observer = new QueryObserver(client, {
    ...threadMemorySavesQuery(thread),
    queryFn: () => new Promise<ReadonlyArray<MemorySave>>((resolve) => pending.push(resolve)),
  });
  const unsubscribe = observer.subscribe(() => {});
  const answer = (n: number, value: ReadonlyArray<MemorySave>) => pending[n]?.(value);
  const shown = () => observer.getCurrentResult().data?.map((each) => `${each.id}${each.undoneAt ? " undone" : ""}`);
  const settled = () => new Promise((resolve) => setTimeout(resolve, 0));
  return { client, answer, shown, settled, reads: () => pending.length, unsubscribe };
};

describe("a thread's memory saves, kept live", () => {
  // covers ADR 028 (The memory tools), #961, STD-REACT-012
  it("[TC-UX-974] a save that arrives while the first read is on its way still shows when that read answers late", async () => {
    const saves = watchedSaves();
    expect(saves.reads()).toBe(1);
    const applied = applyMemorySave(saves.client, save("s1"));
    await saves.settled();
    expect(saves.reads()).toBe(2);
    saves.answer(1, [save("s1")]);
    saves.answer(0, []);
    await applied;
    await saves.settled();
    expect(saves.shown()).toEqual(["s1"]);
    saves.unsubscribe();
  });

  // covers ADR 028 (Writes), #961, STD-REACT-012
  it("[TC-UX-975] an Undo that arrives while a later read is on its way is not put back by that read", async () => {
    const saves = watchedSaves();
    saves.answer(0, [save("s1")]);
    await saves.settled();
    void saves.client.invalidateQueries({ queryKey: threadMemorySavesQuery(thread).queryKey });
    await saves.settled();
    expect(saves.reads()).toBe(2);
    const applied = applyMemorySave(saves.client, save("s1", "2026-11-05T10:00:00.000Z", "2026-11-05T10:00:00.000Z"));
    expect(saves.shown()).toEqual(["s1 undone"]);
    await saves.settled();
    saves.answer(1, [save("s1")]);
    saves.answer(2, [save("s1", "2026-11-05T10:00:00.000Z", "2026-11-05T10:00:00.000Z")]);
    await applied;
    await saves.settled();
    expect(saves.shown()).toEqual(["s1 undone"]);
    saves.unsubscribe();
  });

  // covers ADR 028 (The memory tools), #961, STD-REACT-012
  it("[TC-UX-976] when the stream resumes, a read on its way is dropped and the saves read again", async () => {
    const saves = watchedSaves();
    const refreshed = refreshMemorySaves(saves.client);
    await saves.settled();
    expect(saves.reads()).toBe(2);
    saves.answer(1, [save("s1")]);
    saves.answer(0, []);
    await refreshed;
    await saves.settled();
    expect(saves.shown()).toEqual(["s1"]);
    saves.unsubscribe();
  });
});
