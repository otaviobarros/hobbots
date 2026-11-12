import { ChapterId, Message, MessageId, ThreadId } from "@hobbots/domain";
import { describe, expect, it } from "vitest";
import { buildPack, plainChapterSummary, tokensOf } from "../src/context-pack.ts";

// Issue #1380: tokens per turn on the last topic of a scripted 200-message, 4-topic chat, before
// and after chapters and the pack. Before, one session resumed across the whole thread, so each turn
// carried the whole transcript so far. After, the last topic's chapter starts a new session from the
// pack, and each turn carries the pack and the chapter so far. The numbers are recorded in
// docs/evidence/2026-11-12-context-pack-tokens.md.

const TOPICS = ["the cat", "the garden", "the trip", "the party"];
const PER_TOPIC = 50;

/** A deterministic message of 400 to 1,300 characters about its topic. */
const scripted = (n: number): Message => {
  const topic = Math.floor(n / PER_TOPIC);
  const role = n % 2 === 0 ? "user" : "assistant";
  const words = `Message ${n} about ${TOPICS[topic]}: `.concat("details and plans ".repeat(22 + ((n * 37) % 50)));
  return new Message({
    id: MessageId.make(`m${n}`),
    threadId: ThreadId.make("chat"),
    role,
    content: words,
    status: "complete",
    error: null,
    configVersion: role === "assistant" ? 1 : null,
    runtime: role === "assistant" ? "claude-code" : null,
    model: role === "assistant" ? "sonnet" : null,
    chapterId: ChapterId.make(`c${topic + 1}`),
    createdAt: new Date(Date.UTC(2026, 10, 12) + n * 60_000).toISOString(),
  });
};

const chat = Array.from({ length: TOPICS.length * PER_TOPIC }, (_, n) => scripted(n));
const tokens = (messages: ReadonlyArray<Message>) => tokensOf(messages.reduce((sum, m) => sum + m.content.length, 0));

/** Tokens each of the last topic's turns starts with: before (the whole thread) and after (pack plus chapter). */
const lastTopicCosts = () => {
  const first = (TOPICS.length - 1) * PER_TOPIC;
  const pack = buildPack({
    memoryBrief: null,
    campBrief: null,
    decisions: [],
    work: { tasks: [], trees: [], questions: [], items: [] },
    carried: [],
    artifacts: [],
    chapters: TOPICS.slice(0, -1).map((title, index) => ({
      number: index + 1,
      title,
      summary: plainChapterSummary(chat.slice(index * PER_TOPIC, (index + 1) * PER_TOPIC)),
    })),
    live: [],
  });
  return Array.from({ length: PER_TOPIC / 2 }, (_, turn) => {
    const at = first + turn * 2;
    return { before: tokens(chat.slice(0, at)), after: pack.report.tokens + tokens(chat.slice(first, at)) };
  });
};

describe("tokens per turn", () => {
  // covers ADR 037 (The context pack), STD-ARCH-018
  it("[TC-CH-1380-08] on the last topic of a 200-message, 4-topic chat, every turn starts with fewer tokens than before", () => {
    const costs = lastTopicCosts();
    expect(costs).toHaveLength(25);
    for (const { before, after } of costs) expect(after).toBeLessThan(before);
    const total = (key: "before" | "after") => costs.reduce((sum, cost) => sum + cost[key], 0);
    // The last topic costs no more than a short chat's plus its own chapter: under a third of before.
    expect(total("after") * 3).toBeLessThan(total("before"));
  });
});
