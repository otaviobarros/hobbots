import { Message, MessageId, ThreadId } from "@hobbots/domain";
import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { applyEvent } from "./events.ts";
import { queryKeys } from "./queries.ts";
import { startGeneration, syncedMessages } from "./sync.ts";

const threadId = ThreadId.make("t1");
const now = "2026-10-30T12:00:00.000Z";
const message = (id: string, status: Message["status"], content: string, revision: number) =>
  new Message({
    id: MessageId.make(id),
    threadId,
    role: "assistant",
    content,
    status,
    error: null,
    configVersion: 1,
    createdAt: now,
    revision,
  });

const messages = (client: QueryClient) => client.getQueryData<ReadonlyArray<Message>>(queryKeys.messages(threadId));

// A fetch the test answers by hand, to land a response after events that happened while it was in flight.
const pendingFetch = () => {
  const answers: Array<(rows: ReadonlyArray<Message>) => void> = [];
  const fetch = () => new Promise<ReadonlyArray<Message>>((resolve) => void answers.push(resolve));
  return { fetch, answer: (rows: ReadonlyArray<Message>) => answers.shift()?.(rows), pending: () => answers.length };
};
const load = (client: QueryClient, fetch: () => Promise<ReadonlyArray<Message>>) =>
  client.fetchQuery({ queryKey: queryKeys.messages(threadId), queryFn: syncedMessages(threadId, fetch) });
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("reply chunks", () => {
  // covers CH-004
  it("[TC-CH-075] applies a repeated chunk once and fetches the thread again after a missed one", async () => {
    const client = new QueryClient();
    client.setQueryData(queryKeys.messages(threadId), [message("m1", "streaming", "Hel", 4)]);
    const delta = (offset: number, text: string) =>
      applyEvent(client, { _tag: "MessageDelta", threadId, messageId: MessageId.make("m1"), offset, delta: text });

    // A reconnect sends the whole text so far at offset 0; only the new part is added.
    delta(0, "Hello");
    delta(3, "lo");
    expect(messages(client)?.[0]?.content).toBe("Hello");
    expect(client.getQueryState(queryKeys.messages(threadId))?.isInvalidated).toBe(false);

    // A chunk past the end of the text means chunks were missed: the text stays and is fetched again.
    delta(9, "!");
    expect(messages(client)?.[0]?.content).toBe("Hello");
    expect(client.getQueryState(queryKeys.messages(threadId))?.isInvalidated).toBe(true);
  });
});

describe("query responses during a sync generation", () => {
  // covers CH-004
  it("[TC-CH-076] a response read before newer events does not revive a removed message or undo a finished reply", async () => {
    const client = new QueryClient();
    const { fetch, answer } = pendingFetch();
    const loading = load(client, fetch);

    // While the request is in flight: the reply finishes, a queued message is removed, another arrives.
    applyEvent(client, { _tag: "MessageUpserted", message: message("m1", "complete", "Hello", 9) });
    applyEvent(client, { _tag: "MessageDequeued", threadId, messageId: MessageId.make("q1"), reason: "removed" });
    applyEvent(client, { _tag: "MessageUpserted", message: message("m2", "streaming", "", 11) });
    answer([message("q1", "queued", "later", 3), message("m1", "streaming", "Hel", 5)]);
    await loading;

    expect(messages(client)?.map((m) => [m.id, m.status, m.content])).toEqual([
      ["m1", "complete", "Hello"],
      ["m2", "streaming", ""],
    ]);
  });

  // covers CH-004
  it("[TC-CH-077] keeps text a chunk already delivered when the response read an older checkpoint", async () => {
    const client = new QueryClient();
    client.setQueryData(queryKeys.messages(threadId), [message("m1", "streaming", "Hello wor", 5)]);
    await load(client, () => Promise.resolve([message("m1", "streaming", "Hel", 5)]));
    expect(messages(client)?.[0]?.content).toBe("Hello wor");
  });

  // covers CH-004
  it("[TC-CH-078] a fresh Ready discards a response from the previous generation and fetches again", async () => {
    const client = new QueryClient();
    const { fetch, answer, pending } = pendingFetch();
    const loading = load(client, fetch);

    // The hub could not resume: whatever this client knew may be stale, and the request with it.
    startGeneration(client);
    answer([message("stale", "complete", "old", 2)]);
    await settle();
    expect(pending()).toBe(1);
    answer([message("m3", "complete", "new", 12)]);
    await loading;

    expect(messages(client)?.map((m) => m.id)).toEqual(["m3"]);
  });
});
