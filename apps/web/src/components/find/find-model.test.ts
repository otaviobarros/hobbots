import {
  AgentId,
  ChapterId,
  DecisionId,
  type FindResult,
  type FoundMessage,
  type FoundRecord,
  MessageId,
  OWNER_ACTOR,
  RegisteredArtifactId,
  ThreadId,
} from "@hobbots/domain";
import { describe, expect, it } from "vitest";
import { findGroups, foundNothing, rowOf } from "./find-model.ts";

const place = {
  threadId: ThreadId.make("t1"),
  threadTitle: "Spring sale",
  threadKind: "chat",
  hobId: AgentId.make("aldric"),
  at: "2026-11-04T09:00:00.000Z",
} as const;

const words = (text: string) => [{ text, match: true }];

const decision = (id: string, state: "active" | "superseded"): FoundRecord => ({
  _tag: "decision",
  ...place,
  messageId: MessageId.make(`m-${id}`),
  snippet: words("free shipping"),
  id: DecisionId.make(id),
  text: "free shipping",
  state,
  actor: OWNER_ACTOR,
});

const artifact = (kind: "code" | "doc"): FoundRecord => ({
  _tag: "artifact",
  ...place,
  messageId: null,
  snippet: words("launch"),
  id: RegisteredArtifactId.make(`a-${kind}`),
  title: "launch.md",
  kind,
  version: 3,
  actor: OWNER_ACTOR,
});

const chapter: FoundRecord = {
  _tag: "chapter",
  ...place,
  messageId: MessageId.make("m-first"),
  snippet: words("The garden"),
  id: ChapterId.make("c1"),
  number: 2,
  title: "The garden",
  summary: null,
};

const message: FoundMessage = {
  _tag: "message",
  ...place,
  messageId: MessageId.make("m-said"),
  snippet: words("shipping"),
  role: "user",
  actor: OWNER_ACTOR,
};

describe("what Find shows (ADR 037, Find)", () => {
  // covers ADR 037 (Find), #1386
  it("[TC-UI-1386-01] groups decisions, artifacts, chapters and messages in that order, leaving out empty groups", () => {
    const found: FindResult = { records: [chapter, decision("d1", "active"), artifact("doc")], messages: [message] };
    expect(findGroups(found, false).map((group) => [group.kind, group.rows.length])).toEqual([
      ["decision", 1],
      ["artifact", 1],
      ["chapter", 1],
      ["message", 1],
    ]);
    expect(findGroups({ records: [], messages: [message] }, false).map((group) => group.kind)).toEqual(["message"]);
    expect(foundNothing({ records: [], messages: [] })).toBe(true);
    expect(foundNothing({ records: [], messages: [message] })).toBe(false);
  });

  // covers ADR 037 (Find), #1386
  it("[TC-UI-1386-02] crosses out a decision that no longer holds and opens each row at its message", () => {
    const holds = rowOf(decision("d1", "active"), false);
    const out = rowOf(decision("d2", "superseded"), false);
    expect([holds.crossedOut, out.crossedOut]).toEqual([false, true]);
    expect(out.target).toEqual({ hobId: "aldric", threadId: "t1", messageId: "m-d2" });
    expect(rowOf(artifact("doc"), false).target.messageId).toBeNull();
    expect(rowOf(chapter, false)).toMatchObject({ glyph: "chapter", chapterNumber: 2, actor: null });
  });

  // covers ADR 037 (Find), #1386
  it("[TC-UI-1386-03] tiles code apart from other artifacts and names the chat only when looking everywhere", () => {
    expect(rowOf(artifact("code"), false)).toMatchObject({ glyph: "code", artifact: { kind: "code", version: 3 } });
    expect(rowOf(artifact("doc"), false).glyph).toBe("file");
    expect(rowOf(message, false).where).toBeNull();
    expect(rowOf(message, true).where).toBe("Spring sale");
  });
});
