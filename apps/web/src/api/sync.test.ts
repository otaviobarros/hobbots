import { AgentId, Chapter, ChapterId, Message, MessageId, Channel, ChannelId } from "@hobbots/domain";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { applyEvent } from "./events.ts";
import { connectionQuery, setConnection } from "./live.ts";
import { queryKeys, upsertMessage } from "./queries.ts";
import { startGeneration, syncedMessages } from "./sync.ts";

const channelId = ChannelId.make("t1");
const now = "2026-10-30T12:00:00.000Z";
const message = (id: string, status: Message["status"], content: string, revision: number) =>
  new Message({
    id: MessageId.make(id),
    channelId,
    role: "assistant",
    content,
    status,
    error: null,
    configVersion: 1,
    createdAt: now,
    revision,
  });

const messages = (client: QueryClient) => client.getQueryData<ReadonlyArray<Message>>(queryKeys.messages(channelId));

// A fetch the test answers by hand, to land a response after events that happened while it was in flight.
const pendingFetch = () => {
  const answers: Array<(rows: ReadonlyArray<Message>) => void> = [];
  const fetch = () => new Promise<ReadonlyArray<Message>>((resolve) => void answers.push(resolve));
  return { fetch, answer: (rows: ReadonlyArray<Message>) => answers.shift()?.(rows), pending: () => answers.length };
};
const load = (client: QueryClient, fetch: () => Promise<ReadonlyArray<Message>>) =>
  client.fetchQuery({
    queryKey: queryKeys.messages(channelId),
    queryFn: syncedMessages(channelId, fetch, upsertMessage),
  });
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("reply chunks", () => {
  it("applies a repeated chunk once and fetches the channel again after a missed one", async () => {
    const client = new QueryClient();
    client.setQueryData(queryKeys.messages(channelId), [message("m1", "streaming", "Hel", 4)]);
    const delta = (offset: number, text: string) =>
      applyEvent(client, { _tag: "MessageDelta", channelId, messageId: MessageId.make("m1"), offset, delta: text });

    // A reconnect sends the whole text so far at offset 0; only the new part is added.
    delta(0, "Hello");
    delta(3, "lo");
    expect(messages(client)?.[0]?.content).toBe("Hello");
    expect(client.getQueryState(queryKeys.messages(channelId))?.isInvalidated).toBe(false);

    // A chunk past the end of the text means chunks were missed: the text stays and is fetched again.
    delta(9, "!");
    expect(messages(client)?.[0]?.content).toBe("Hello");
    expect(client.getQueryState(queryKeys.messages(channelId))?.isInvalidated).toBe(true);
  });
});

describe("query responses during a sync generation", () => {
  it("a response read before newer events does not revive a removed message or undo a finished reply", async () => {
    const client = new QueryClient();
    const { fetch, answer } = pendingFetch();
    const loading = load(client, fetch);

    // While the request is in flight: the reply finishes, a queued message is removed, another arrives.
    applyEvent(client, { _tag: "MessageUpserted", message: message("m1", "complete", "Hello", 9) });
    applyEvent(client, { _tag: "MessageDequeued", channelId, messageId: MessageId.make("q1"), reason: "removed" });
    applyEvent(client, { _tag: "MessageUpserted", message: message("m2", "streaming", "", 11) });
    answer([message("q1", "queued", "later", 3), message("m1", "streaming", "Hel", 5)]);
    await loading;

    expect(messages(client)?.map((m) => [m.id, m.status, m.content])).toEqual([
      ["m1", "complete", "Hello"],
      ["m2", "streaming", ""],
    ]);
  });

  it("keeps text a chunk already delivered when the response read an older checkpoint", async () => {
    const client = new QueryClient();
    client.setQueryData(queryKeys.messages(channelId), [message("m1", "streaming", "Hello wor", 5)]);
    await load(client, () => Promise.resolve([message("m1", "streaming", "Hel", 5)]));
    expect(messages(client)?.[0]?.content).toBe("Hello wor");
  });

  it("keeps the streamed text of a reply that started after the response was read", async () => {
    const client = new QueryClient();
    client.setQueryData(queryKeys.messages(channelId), [message("u1", "complete", "hi", 6)]);
    const { fetch, answer } = pendingFetch();
    const loading = load(client, fetch);

    applyEvent(client, { _tag: "MessageUpserted", message: message("m1", "streaming", "", 7) });
    applyEvent(client, { _tag: "MessageDelta", channelId, messageId: MessageId.make("m1"), offset: 0, delta: "Hel" });
    answer([message("u1", "complete", "hi", 6)]);
    await loading;

    expect(messages(client)?.map((m) => [m.id, m.content])).toEqual([
      ["u1", "hi"],
      ["m1", "Hel"],
    ]);
  });

  it("a queued message that started after the response was read moves after the reply before it", async () => {
    const client = new QueryClient();
    const user = (id: string, status: Message["status"], revision: number) =>
      new Message({ ...message(id, status, id, revision), role: "user", configVersion: null });
    const { fetch, answer } = pendingFetch();
    const loading = load(client, fetch);

    // The reply finishes and the queued prompt starts while the request is in flight.
    applyEvent(client, { _tag: "MessageUpserted", message: message("m1", "complete", "Hello", 8) });
    applyEvent(client, { _tag: "MessageUpserted", message: user("q1", "complete", 9) });
    answer([user("u1", "complete", 2), user("q1", "queued", 3), message("m1", "streaming", "Hel", 4)]);
    await loading;

    expect(messages(client)?.map((m) => [m.id, m.status])).toEqual([
      ["u1", "complete"],
      ["m1", "complete"],
      ["q1", "complete"],
    ]);
  });

  it("a fresh Ready discards a response from the previous generation and fetches again", async () => {
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

  it("a fresh Ready leaves what only this client knows, such as the connection", async () => {
    const client = new QueryClient();
    // A screen showing the connection keeps its query active, so a resync would refetch it.
    const watching = new QueryObserver(client, connectionQuery).subscribe(() => undefined);
    await settle();
    setConnection(client, "live");

    startGeneration(client);
    await settle();

    expect(client.getQueryData(connectionQuery.queryKey)).toBe("live");
    watching();
  });
});

describe("a chapter moved into a camp", () => {
  // covers ADR 037 (Moving a chapter into a camp moves it), CH-009, STD-REACT-028
  it("shows a message an event brought in the camp it moved to, and never again in the chat (#1385)", async () => {
    const client = new QueryClient();
    const campId = ChannelId.make("camp-1");
    const chapter = (id: string, channel: ChannelId, state: "moved" | "live", revision: number) =>
      new Chapter({
        id: ChapterId.make(id),
        channelId: channel,
        number: 1,
        title: null,
        summary: null,
        state,
        startedAt: now,
        endedAt: state === "moved" ? now : null,
        movedTo: state === "moved" ? campId : null,
        revision,
      });
    const channel = (id: ChannelId, kind: "direct" | "camp") =>
      new Channel({ id, agentId: AgentId.make("a1"), title: id, kind, createdAt: now, updatedAt: now, revision: 9 });
    const inChat = new Message({ ...message("m1", "complete", "Plant beans.", 4), chapterId: ChapterId.make("c1") });
    // The reply arrived live, so the overlay holds it, in the chat.
    applyEvent(client, { _tag: "MessageUpserted", message: inChat });
    applyEvent(client, {
      _tag: "ChapterMoved",
      channelId,
      channel: channel(channelId, "direct"),
      camp: channel(campId, "camp"),
      stub: chapter("c1", channelId, "moved", 9),
      chapter: chapter("k1", campId, "live", 9),
      chapters: [],
      campChapters: [],
    });

    // The chat's read no longer has it, and nothing adds it back.
    expect(await load(client, () => Promise.resolve([]))).toEqual([]);
    const inCamp = await client.fetchQuery({
      queryKey: queryKeys.messages(campId),
      queryFn: syncedMessages(campId, () => Promise.resolve([]), upsertMessage),
    });
    expect(inCamp.map((each) => [each.id, each.channelId, each.chapterId, each.revision])).toEqual([
      ["m1", campId, "k1", 9],
    ]);
  });

  // covers ADR 037 (Moving a chapter into a camp moves it), STD-REACT-012
  it("drops a first transcript read that began before the move, which no event told about the message (#1385)", async () => {
    const client = new QueryClient();
    const campId = ChannelId.make("camp-1");
    const chapter = (id: string, channel: ChannelId, state: "moved" | "live") =>
      new Chapter({
        id: ChapterId.make(id),
        channelId: channel,
        number: 1,
        title: null,
        summary: null,
        state,
        startedAt: now,
        endedAt: state === "moved" ? now : null,
        movedTo: state === "moved" ? campId : null,
        revision: 9,
      });
    const channel = (id: ChannelId, kind: "direct" | "camp") =>
      new Channel({ id, agentId: AgentId.make("a1"), title: id, kind, createdAt: now, updatedAt: now, revision: 9 });
    const inChat = new Message({ ...message("m1", "complete", "Plant beans.", 4), chapterId: ChapterId.make("c1") });
    // The chat opens and reads its transcript; the read is slow, and nothing is cached yet.
    const { fetch, answer, pending } = pendingFetch();
    const watching = new QueryObserver(client, {
      queryKey: queryKeys.messages(channelId),
      queryFn: syncedMessages(channelId, fetch, upsertMessage),
    }).subscribe(() => undefined);
    await settle();
    expect(pending()).toBe(1);

    // Another device moves the chapter while the read is on its way; no MessageUpserted came before.
    applyEvent(client, {
      _tag: "ChapterMoved",
      channelId,
      channel: channel(channelId, "direct"),
      camp: channel(campId, "camp"),
      stub: chapter("c1", channelId, "moved"),
      chapter: chapter("k1", campId, "live"),
      chapters: [],
      campChapters: [],
    });
    await settle();
    // The read from before the move answers with the message, then the read after it without.
    answer([inChat]);
    await settle();
    answer([]);
    await vi.waitFor(() => expect(messages(client)).toEqual([]));
    watching();
  });
});
