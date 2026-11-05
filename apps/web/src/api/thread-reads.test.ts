import { AgentId, Message, MessageId, Thread, ThreadId } from "@hobbots/domain";
import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { applyEvent } from "./events.ts";
import { queryKeys, threadsQuery } from "./queries.ts";
import { syncedThreads } from "./sync.ts";
import { lastRead, readThrough, showUnread } from "./thread-reads.ts";

const agentId = AgentId.make("aldric");
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
  client.getQueryData<ReadonlyArray<Thread>>(queryKeys.threads(agentId))?.[0]?.unread;

const syncedListOf = (rows: Promise<ReadonlyArray<Thread>>) =>
  syncedThreads(
    agentId,
    () => rows,
    (threads) => threads,
    false,
  );

const withThread = () => {
  const client = new QueryClient();
  client.setQueryData(queryKeys.threads(agentId), [
    new Thread({ id: threadId, agentId, title: "Plan", createdAt: now, updatedAt: now }),
  ]);
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
  it("[TC-UX-959] a list of chats that lands after a reply ended still shows it unread, until a read says otherwise", async () => {
    const thread = (revision: number, unread = false) =>
      new Thread({ id: threadId, agentId, title: "Plan", createdAt: now, updatedAt: now, revision, unread });
    const at = (status: Message["status"], revision: number) => new Message({ ...reply("m1", status), revision });
    const answering = () => {
      let answer: (rows: ReadonlyArray<Thread>) => void = () => undefined;
      const rows = new Promise<ReadonlyArray<Thread>>((resolve) => {
        answer = resolve;
      });
      return { rows, answer: (threads: ReadonlyArray<Thread>) => answer(threads) };
    };
    const load = (client: QueryClient, rows: Promise<ReadonlyArray<Thread>>) =>
      client.fetchQuery({ ...threadsQuery(agentId), queryFn: syncedListOf(rows) });

    // The hub read the list before the reply ended; the reply's events land before its answer does.
    const early = new QueryClient();
    const first = answering();
    const loading = load(early, first.rows);
    applyEvent(early, { _tag: "ThreadUpserted", thread: thread(3) });
    applyEvent(early, { _tag: "MessageUpserted", message: at("streaming", 4) });
    applyEvent(early, { _tag: "MessageUpserted", message: at("complete", 6) });
    first.answer([thread(3)]);
    await loading;
    expect(listed(early)).toBe(true);

    // A list read after the reply ended keeps its dot, though the thread's last event came before it.
    await load(early, Promise.resolve([thread(3, true)]));
    expect(listed(early)).toBe(true);

    // Reading it on another device moves the thread on: the dot goes, and a list read later agrees.
    applyEvent(early, { _tag: "ThreadUpserted", thread: thread(8) });
    expect(listed(early)).toBe(false);
    await load(early, Promise.resolve([thread(8)]));
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
