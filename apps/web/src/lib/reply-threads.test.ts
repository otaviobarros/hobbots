import { type Actor, ChannelId, hobActor, Message, MessageId, type MessageStatus, OWNER_ACTOR } from "@hobbots/domain";
import { describe, expect, it } from "vitest";
import { chatLines, repliesIn, threadLines } from "./reply-threads.ts";

const LEO: Actor = { kind: "user", id: "leo" };
const QUILL = hobActor("quill");

const message = (
  id: string,
  { root = null, also = false, actor = OWNER_ACTOR, status = "complete" as MessageStatus, minute = 0 } = {},
) =>
  new Message({
    id: MessageId.make(id),
    channelId: ChannelId.make("camp"),
    actor,
    role: actor.kind === "hob" ? "assistant" : "user",
    content: id,
    status,
    error: null,
    configVersion: null,
    rootMessageId: root === null ? null : MessageId.make(root),
    alsoInMainLine: also,
    createdAt: new Date(Date.UTC(2026, 10, 16, 11, minute)).toISOString(),
    revision: 1,
  });

const ask = message("ask");
const said = [
  ask,
  message("r1", { root: "ask", actor: LEO, minute: 16 }),
  message("r2", { root: "ask", minute: 17 }),
  message("r3", { root: "ask", actor: LEO, also: true, minute: 18 }),
  message("r4", { root: "ask", actor: QUILL, minute: 19 }),
  message("later"),
];

describe("reply threads in the chat (#1484)", () => {
  it("keeps replies only in a thread out of the main line, and waiting messages out of both", () => {
    const lines = chatLines([...said, message("waiting", { status: "queued" })]);
    expect(lines.said?.map((each) => each.id)).toEqual(["ask", "r1", "r2", "r3", "r4", "later"]);
    expect(lines.transcript?.map((each) => each.id)).toEqual(["ask", "r3", "later"]);
    expect(chatLines(undefined)).toEqual({ said: undefined, transcript: undefined });
  });

  it("lists a root's replies in the order they were sent", () => {
    expect(repliesIn(said, MessageId.make("ask")).map((each) => each.id)).toEqual(["r1", "r2", "r3", "r4"]);
    expect(repliesIn(said, MessageId.make("later"))).toEqual([]);
  });

  it("gives each root one line: who replied, latest first and each once, the count and the last reply's time", () => {
    const lines = threadLines(said);
    expect([...lines.keys()]).toEqual(["ask"]);
    expect(lines.get(MessageId.make("ask"))).toEqual({
      repliers: [QUILL, LEO, OWNER_ACTOR],
      count: 4,
      lastAt: "2026-11-16T11:19:00.000Z",
    });
  });
});
