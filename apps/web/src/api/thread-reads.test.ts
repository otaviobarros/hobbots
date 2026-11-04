import { AgentId, Message, MessageId, Thread, ThreadId } from "@hobbots/domain";
import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { queryKeys } from "./queries.ts";
import { lastRead, showUnread } from "./thread-reads.ts";

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

  it("reads through the last message seen whole, never one still under way or queued", () => {
    const queued = new Message({ ...reply("m4", "queued"), role: "user", configVersion: null });
    expect(lastRead([reply("m1", "complete"), reply("m2", "streaming"), queued])?.id).toBe("m1");
    expect(lastRead([])).toBeUndefined();
  });
});
