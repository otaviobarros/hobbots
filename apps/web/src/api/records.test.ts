import {
  Artifact,
  CampSuggestion,
  CampSuggestionId,
  ChapterId,
  Decision,
  DecisionId,
  MessageId,
  MessagePin,
  RegisteredArtifactId,
  ThreadId,
} from "@hobbots/domain";
import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { applySuggestionEvent } from "./camp-suggestions.ts";
import { applyPinEvent, catchUpQuery, recordsMoved } from "./notes.ts";
import { applyRecordEvent, recordKeys } from "./records.ts";

// Issue #1387 (ADR 037): the camp sheet's lists, the suggestion card and pins read again on their
// events, each cancelling a read already on its way first (STD-REACT-012).

const threadId = ThreadId.make("camp-1");
const at = "2026-11-12T00:00:00.000Z";
const hob = { kind: "hob", id: "hob-1" } as const;

const decision = new Decision({
  id: DecisionId.make("d1"),
  threadId,
  chapterId: ChapterId.make("c1"),
  sourceMessageId: null,
  text: "Ship on Fridays.",
  actor: hob,
  state: "active",
  supersededBy: null,
  recordedAt: at,
  supersededAt: null,
  revision: 3,
});

/** The calls each spy saw for `key`, in order. */
const watch = (client: QueryClient, key: ReadonlyArray<unknown>) => {
  const calls: Array<string> = [];
  const record = (name: string) => (filters?: { readonly queryKey?: ReadonlyArray<unknown> }) => {
    if (JSON.stringify(filters?.queryKey) === JSON.stringify(key)) calls.push(name);
    return Promise.resolve();
  };
  vi.spyOn(client, "cancelQueries").mockImplementation(record("cancel"));
  vi.spyOn(client, "invalidateQueries").mockImplementation(record("invalidate"));
  return calls;
};

describe("record events", () => {
  it("[TC-CH-1387-20] reads the thread's decisions, artifacts and brief again, cancelling a read on its way first", async () => {
    for (const [event, key] of [
      [{ _tag: "DecisionRecorded", decision } as const, recordKeys.decisions(threadId)],
      [{ _tag: "DecisionSuperseded", decision } as const, recordKeys.decisions(threadId)],
      [
        {
          _tag: "ArtifactRegistered",
          artifact: new Artifact({
            id: RegisteredArtifactId.make("a1"),
            threadId,
            chapterId: ChapterId.make("c1"),
            kind: "doc",
            title: "plan.md",
            locator: "/work/plan.md",
            latestVersion: 1,
            origin: { kind: "message", id: "m1" },
            actor: hob,
            createdAt: at,
            updatedAt: at,
            revision: 4,
          }),
        } as const,
        recordKeys.artifacts(threadId),
      ],
    ] as const) {
      const client = new QueryClient();
      const calls = watch(client, key);
      await applyRecordEvent(client, event);
      expect(calls).toEqual(["cancel", "invalidate"]);
    }
  });

  it("[TC-CH-1387-21] reads a thread's pins and camp suggestions again on their events", async () => {
    const pins = new QueryClient();
    const pinCalls = watch(pins, ["threads", threadId, "pins"]);
    await applyPinEvent(pins, {
      _tag: "MessagePinned",
      pin: new MessagePin({ messageId: MessageId.make("m1"), threadId, pinnedAt: at, revision: 5 }),
    });
    await applyPinEvent(pins, { _tag: "MessageUnpinned", threadId, messageId: MessageId.make("m1") });
    expect(pinCalls).toEqual(["cancel", "invalidate", "cancel", "invalidate"]);

    const suggestions = new QueryClient();
    const suggestionCalls = watch(suggestions, ["threads", threadId, "campSuggestions"]);
    await applySuggestionEvent(suggestions, {
      _tag: "CampSuggestionExpired",
      threadId,
      suggestion: new CampSuggestion({
        id: CampSuggestionId.make("s1"),
        threadId,
        chapterId: ChapterId.make("c1"),
        reasons: [{ code: "decisions", count: 5 }],
        state: "expired",
        raisedAt: at,
        settledAt: at,
        campId: null,
        revision: 6,
      }),
    });
    expect(suggestionCalls).toEqual(["cancel", "invalidate"]);
  });

  it("[TC-CH-1387-30] reads both threads' decisions, artifacts and pins again when a chapter moves between them", async () => {
    const camp = ThreadId.make("camp-2");
    const client = new QueryClient();
    const keys = [threadId, camp].flatMap((each) => [
      recordKeys.decisions(each),
      recordKeys.artifacts(each),
      ["threads", each, "pins"],
    ]);
    const calls: Array<string> = [];
    const record = (name: string) => (filters?: { readonly queryKey?: ReadonlyArray<unknown> }) => {
      calls.push(`${name} ${JSON.stringify(filters?.queryKey)}`);
      return Promise.resolve();
    };
    vi.spyOn(client, "cancelQueries").mockImplementation(record("cancel"));
    vi.spyOn(client, "invalidateQueries").mockImplementation(record("invalidate"));
    await recordsMoved(client, [threadId, camp]);
    for (const key of keys) {
      const own = calls.filter((call) => call.endsWith(JSON.stringify(key)));
      expect(own.map((call) => call.split(" ")[0])).toEqual(["cancel", "invalidate"]);
    }
  });
});

describe("catch-up reads", () => {
  it("[TC-CH-1387-31] keys each visit's read on its own and drops it once nothing reads it", () => {
    const first = catchUpQuery(threadId, "m1:1");
    const remounted = catchUpQuery(threadId, "m2:1");
    expect(first.queryKey).not.toEqual(remounted.queryKey);
    expect(first.gcTime).toBe(0);
  });
});
