import {
  Artifact,
  CampSuggestion,
  CampSuggestionId,
  ChannelId,
  ChapterId,
  Decision,
  DecisionId,
  MessageId,
  MessagePin,
  RegisteredArtifactId,
} from "@hobbots/domain";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { applySuggestionEvent } from "./camp-suggestions.ts";
import { ApiError } from "./client.ts";
import { applyPinEvent, catchUpQuery, recordsMoved } from "./notes.ts";
import { applyRecordEvent, recordKeys, reviewArtifactError } from "./records.ts";

// Issue #1387 (ADR 037): the camp sheet's lists, the suggestion card and pins read again on their
// events, each cancelling a read already on its way first (STD-REACT-012).

const channelId = ChannelId.make("camp-1");
const at = "2026-11-12T00:00:00.000Z";
const hob = { kind: "hob", id: "hob-1" } as const;

const decision = new Decision({
  id: DecisionId.make("d1"),
  channelId,
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

const artifact = new Artifact({
  id: RegisteredArtifactId.make("a1"),
  channelId,
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
  it("reads the channel's decisions, artifacts and brief again, cancelling a read on its way first (#1387)", async () => {
    for (const [event, key] of [
      [{ _tag: "DecisionRecorded", decision } as const, recordKeys.decisions(channelId)],
      [{ _tag: "DecisionSuperseded", decision } as const, recordKeys.decisions(channelId)],
      [
        {
          _tag: "ArtifactRegistered",
          artifact,
        } as const,
        recordKeys.artifacts(channelId),
      ],
      [{ _tag: "ArtifactReviewSettled", artifact } as const, recordKeys.artifacts(channelId)],
    ] as const) {
      const client = new QueryClient();
      const calls = watch(client, key);
      await applyRecordEvent(client, event);
      expect(calls).toEqual(["cancel", "invalidate"]);
    }
  });

  it("reads a channel's pins and camp suggestions again on their events (#1387)", async () => {
    const pins = new QueryClient();
    const pinCalls = watch(pins, ["channels", channelId, "pins"]);
    await applyPinEvent(pins, {
      _tag: "MessagePinned",
      pin: new MessagePin({ messageId: MessageId.make("m1"), channelId, pinnedAt: at, revision: 5 }),
    });
    await applyPinEvent(pins, { _tag: "MessageUnpinned", channelId, messageId: MessageId.make("m1") });
    expect(pinCalls).toEqual(["cancel", "invalidate", "cancel", "invalidate"]);

    const suggestions = new QueryClient();
    const suggestionCalls = watch(suggestions, ["channels", channelId, "campSuggestions"]);
    await applySuggestionEvent(suggestions, {
      _tag: "CampSuggestionExpired",
      channelId,
      suggestion: new CampSuggestion({
        id: CampSuggestionId.make("s1"),
        channelId,
        chapterId: ChapterId.make("c1"),
        reasons: [{ code: "decisions", count: 5 }],
        title: null,
        goal: null,
        state: "expired",
        raisedAt: at,
        settledAt: at,
        campId: null,
        revision: 6,
      }),
    });
    expect(suggestionCalls).toEqual(["cancel", "invalidate"]);
  });

  it("reads both channels' decisions, artifacts and pins again when a chapter moves between them (#1387)", async () => {
    const camp = ChannelId.make("camp-2");
    const client = new QueryClient();
    const keys = [channelId, camp].flatMap((each) => [
      recordKeys.decisions(each),
      recordKeys.artifacts(each),
      ["channels", each, "pins"],
    ]);
    const calls: Array<string> = [];
    const record = (name: string) => (filters?: { readonly queryKey?: ReadonlyArray<unknown> }) => {
      calls.push(`${name} ${JSON.stringify(filters?.queryKey)}`);
      return Promise.resolve();
    };
    vi.spyOn(client, "cancelQueries").mockImplementation(record("cancel"));
    vi.spyOn(client, "invalidateQueries").mockImplementation(record("invalidate"));
    await recordsMoved(client, [channelId, camp]);
    for (const key of keys) {
      const own = calls.filter((call) => call.endsWith(JSON.stringify(key)));
      expect(own.map((call) => call.split(" ")[0])).toEqual(["cancel", "invalidate"]);
    }
  });
});

describe("catch-up reads", () => {
  it("keys each visit's read on its own and drops it once nothing reads it (#1387)", () => {
    const first = catchUpQuery(channelId, "m1:1");
    const remounted = catchUpQuery(channelId, "m2:1");
    expect(first.queryKey).not.toEqual(remounted.queryKey);
    expect(first.gcTime).toBe(0);
  });
});

describe("artifact reviews", () => {
  it("tells a review the hub refused from one that did not reach it (#1387)", () => {
    expect(reviewArtifactError(new ApiError("refused", "ArtifactReviewChangeRefused"))).toBe("refused");
    expect(reviewArtifactError(new ApiError("gone", "ChannelNotFound"))).toBe("unreachable");
    expect(reviewArtifactError(new Error("offline"))).toBe("unreachable");
  });
});

describe("artifact reads (#1434)", () => {
  /** A read the test answers when it chooses. */
  const deferred = <A>() => {
    let resolve: (value: A) => void = () => undefined;
    const promise = new Promise<A>((done) => {
      resolve = done;
    });
    return { promise, resolve };
  };

  it("a new version cancels the first read of its versions on its way, so the read after the event is kept (#1434)", async () => {
    const client = new QueryClient();
    const queryKey = recordKeys.versions(channelId, artifact.id);
    const first = deferred<string>();
    const answers = [() => first.promise, () => Promise.resolve("version 2")];
    const observer = new QueryObserver(client, {
      queryKey,
      queryFn: () => (answers.shift() ?? (() => Promise.resolve("again")))(),
      staleTime: Number.POSITIVE_INFINITY,
    });
    const stop = observer.subscribe(() => undefined);
    await applyRecordEvent(client, { _tag: "ArtifactRegistered", artifact });
    first.resolve("version 1");
    await vi.waitFor(() => expect(client.getQueryData(queryKey)).toBe("version 2"));
    await first.promise;
    expect(client.getQueryData(queryKey)).toBe("version 2");
    stop();
  });

  it("a chapter move drops each artifact's versions and kept contents, and reads the shown ones again (#1434)", async () => {
    const client = new QueryClient();
    const versions = recordKeys.versions(channelId, artifact.id);
    const kept = recordKeys.content(channelId, artifact.id, 1);
    client.setQueryData(kept, new TextEncoder().encode("before the move"));
    let reads = 0;
    const observer = new QueryObserver(client, {
      queryKey: versions,
      queryFn: () => Promise.resolve(`read ${++reads}`),
      staleTime: Number.POSITIVE_INFINITY,
    });
    const stop = observer.subscribe(() => undefined);
    await vi.waitFor(() => expect(client.getQueryData(versions)).toBe("read 1"));
    await recordsMoved(client, [channelId]);
    expect(client.getQueryData(kept)).toBeUndefined();
    await vi.waitFor(() => expect(client.getQueryData(versions)).toBe("read 2"));
    stop();
  });
});
