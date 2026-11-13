import { Message, MessageId, ThreadId, ThreadMember, UnreadThreads } from "@hobbots/domain";
import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { applyEvent } from "./events.ts";
import { queryKeys } from "./queries.ts";
import { syncedUnread } from "./sync.ts";
import { lastRead, readThrough, showUnread, unreadThreadsQuery } from "./thread-reads.ts";

const threadId = ThreadId.make("t1");
const now = "2026-11-04T00:00:00.000Z";

const reply = (id: string, status: Message["status"], content = "The plan is ready.") =>
  new Message({
    id: MessageId.make(id),
    threadId,
    role: "assistant",
    content,
    status,
    error: null,
    configVersion: 1,
    createdAt: now,
  });

const listed = (client: QueryClient) =>
  client.getQueryData<ReadonlyArray<ThreadId>>(queryKeys.unreadThreads)?.includes(threadId);

/** A client that read your unread threads from the hub: none. */
const withThread = () => {
  const client = new QueryClient();
  client.setQueryData<ReadonlyArray<ThreadId>>(queryKeys.unreadThreads, []);
  return client;
};

describe("unread threads", () => {
  // covers UX-006
  it("[TC-UX-192] shows a thread unread once the lead's reply ends, never for one under way or one already held", () => {
    const client = withThread();
    showUnread(client, reply("m1", "streaming"));
    expect(listed(client)).toBe(false);
    client.setQueryData(queryKeys.messages(threadId), [reply("m1", "streaming")]);
    showUnread(client, reply("m1", "complete"));
    expect(listed(client)).toBe(true);

    // A reply the transcript already held as ended, written again, was there before you read it.
    const read = withThread();
    read.setQueryData(queryKeys.messages(threadId), [reply("m1", "complete")]);
    showUnread(read, reply("m1", "complete"));
    expect(listed(read)).toBe(false);
    // A reply with no words leaves nothing to read, unless it failed.
    showUnread(read, reply("m2", "complete", " "));
    expect(listed(read)).toBe(false);
    showUnread(read, reply("m3", "failed", ""));
    expect(listed(read)).toBe(true);
  });

  // covers UX-006
  it("[TC-UX-959] a list of unread threads that lands after a reply ended still shows it unread, until a read says otherwise", async () => {
    const at = (status: Message["status"], revision: number) => new Message({ ...reply("m1", status), revision });
    const unread = (through: number, ids: ReadonlyArray<ThreadId> = []) =>
      new UnreadThreads({ threadIds: ids, through });
    const answering = () => {
      let answer: (read: UnreadThreads) => void = () => undefined;
      const read = new Promise<UnreadThreads>((resolve) => {
        answer = resolve;
      });
      return { read, answer: (value: UnreadThreads) => answer(value) };
    };
    // Each load reads the list again: the query is otherwise fresh forever, as it follows events.
    let reads = 0;
    const load = (client: QueryClient, read: Promise<UnreadThreads>) =>
      client.fetchQuery({
        ...unreadThreadsQuery,
        staleTime: 0,
        queryFn: syncedUnread(() => {
          reads += 1;
          return read;
        }),
      });

    // The hub read the list before the reply ended; the reply's events land before its answer does.
    const early = new QueryClient();
    const first = answering();
    const loading = load(early, first.read);
    applyEvent(early, { _tag: "MessageUpserted", message: at("streaming", 4) });
    applyEvent(early, { _tag: "MessageUpserted", message: at("complete", 6) });
    first.answer(unread(3));
    await loading;
    expect(reads).toBe(1);
    expect(listed(early)).toBe(true);

    // A list read after the reply ended keeps its dot.
    await load(early, Promise.resolve(unread(6, [threadId])));
    expect(reads).toBe(2);
    expect(listed(early)).toBe(true);

    // You read it on another device: your member row moves on, and the list read again agrees, though
    // the reply that ended is still this generation's.
    const member = new ThreadMember({
      threadId,
      actor: { kind: "user", id: "owner" },
      role: "owner",
      state: "active",
      joinedAt: now,
      addedBy: { kind: "user", id: "owner" },
      readRevision: 6,
      mutedUntil: null,
      revision: 8,
    });
    applyEvent(early, { _tag: "ThreadMemberChanged", member });
    expect(early.getQueryState(queryKeys.unreadThreads)?.isInvalidated).toBe(true);
    await load(early, Promise.resolve(unread(8)));
    expect(reads).toBe(3);
    expect(listed(early)).toBe(false);
  });

  it("reads through the last message seen whole, never one still under way or queued", () => {
    const queued = new Message({ ...reply("m4", "queued"), role: "user", configVersion: null });
    expect(lastRead([reply("m1", "complete"), reply("m2", "streaming"), queued])?.id).toBe("m1");
    expect(lastRead([])).toBeUndefined();
  });

  // covers UX-006
  it("[TC-UX-195] reads through the newest revision seen up to that message, not one that came after", () => {
    const at = (id: string, status: Message["status"], revision: number) =>
      new Message({ ...reply(id, status), revision });
    // The reply after the one read is still under way, so its newer revision is not seen yet.
    expect(readThrough([at("m1", "complete", 9), at("m2", "complete", 4), at("m3", "streaming", 12)])).toEqual({
      messageId: "m2",
      revision: 9,
    });
    expect(readThrough([])).toBeUndefined();
  });
});
