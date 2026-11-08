import { WebFoundUrls } from "@hobbots/agents";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { WebFoundUrlsLive } from "../src/index.ts";
import { TestDatabase } from "../src/testing.ts";

// Issue #1267: each session's found URLs (ADR 036), kept by the work they belong to, on SQLite and
// PostgreSQL alike.
describe("The URLs a session found", () => {
  // covers ADR 036 (Where a URL came from)
  it("[TC-PE-1267-09] keeps each URL once per work with where it was found first, and many at once", async () => {
    const many = Array.from({ length: 1_200 }, (_, index) => `https://example.test/${index}`);
    const found = await Effect.gen(function* () {
      const store = yield* WebFoundUrls;
      const before = yield* store.sources("thread:t1", ["https://example.test/a"]);
      yield* store.add("thread:t1", [
        { url: "https://example.test/a", source: "a link on https://example.test/" },
        { url: "https://example.test/a", source: "a second time" },
      ]);
      yield* store.add("thread:t1", [{ url: "https://example.test/a", source: "later" }]);
      yield* store.add(
        "task:k1",
        many.map((url) => ({ url, source: "a link on https://example.test/" })),
      );
      return {
        before,
        thread: yield* store.sources("thread:t1", ["https://example.test/a", "https://example.test/b"]),
        otherWork: yield* store.sources("task:k1", ["https://example.test/a"]),
        many: yield* store.sources("task:k1", many),
      };
    }).pipe(Effect.provide(WebFoundUrlsLive), Effect.provide(TestDatabase), Effect.runPromise);

    expect(found.before.size).toBe(0);
    expect([...found.thread]).toEqual([["https://example.test/a", "a link on https://example.test/"]]);
    expect(found.otherWork.size).toBe(0);
    expect(found.many.size).toBe(1_200);
  });
});
