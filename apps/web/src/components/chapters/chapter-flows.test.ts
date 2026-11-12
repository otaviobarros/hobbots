import { CHAPTER_TITLE_MAX, ChapterId, MessageId } from "@hobbots/domain";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { ApiError } from "../../api/client.ts";
import {
  canRetry,
  chapterChangeError,
  MERGE_IDLE,
  type MergeChapterEvent,
  mergeStep,
  SPLIT_CLOSED,
  type SplitChapter,
  type SplitChapterEvent,
  splitStep,
  titleProblem,
} from "./chapter-flows.ts";

const M1 = MessageId.make("m1");
const K1 = ChapterId.make("k1");
const K2 = ChapterId.make("k2");
const C1 = ChapterId.make("c1");

const run = (events: ReadonlyArray<SplitChapterEvent>, from: SplitChapter = SPLIT_CLOSED) =>
  events.reduce(splitStep, from);

describe("Split here", () => {
  it("asks for a title first, then splits under a new key, and tries again under the same one", () => {
    const naming = run([{ _tag: "Open", messageId: M1 }]);
    expect(naming).toEqual({ step: "naming", messageId: M1, title: "", shown: false });
    // Without a title nothing is sent, and the problem shows.
    expect(run([{ _tag: "Send", key: K1 }], naming)).toEqual({ ...naming, shown: true });

    const splitting = run(
      [
        { _tag: "Edit", title: "  The garden " },
        { _tag: "Send", key: K1 },
      ],
      naming,
    );
    expect(splitting).toEqual({ step: "splitting", messageId: M1, title: "  The garden ", key: K1 });
    // A second press, or an edit, while it splits changes nothing.
    expect(
      run(
        [
          { _tag: "Send", key: K2 },
          { _tag: "Edit", title: "x" },
        ],
        splitting,
      ),
    ).toBe(splitting);

    const failed = run([{ _tag: "Failed", error: "unreachable" }], splitting);
    expect(failed).toMatchObject({ step: "failed", key: K1, error: "unreachable", title: "  The garden " });
    expect(run([{ _tag: "Send", key: K2 }], failed)).toMatchObject({ step: "splitting", key: K1 });
    // An edit after a failure asks again, under a new key.
    expect(
      run(
        [
          { _tag: "Edit", title: "The orchard" },
          { _tag: "Send", key: K2 },
        ],
        failed,
      ),
    ).toMatchObject({
      step: "splitting",
      key: K2,
    });
    expect(run([{ _tag: "Close" }], failed)).toBe(SPLIT_CLOSED);
  });

  it("reads a title as the hub does: trimmed, not empty, and no longer than a chapter's", () => {
    expect(titleProblem("   ")).toBe("title-missing");
    expect(titleProblem(` ${"a".repeat(CHAPTER_TITLE_MAX)} `)).toBeNull();
    expect(titleProblem("a".repeat(CHAPTER_TITLE_MAX + 1))).toBe("title-long");
  });

  it("names the hub's refusal, and offers a try again only for a lost answer", () => {
    const refused = (reason: string) => chapterChangeError(new ApiError("", "ChapterChangeRefused", { reason }));
    expect(refused("chapter-start")).toBe("chapter-start");
    expect(refused("first-chapter")).toBe("first-chapter");
    expect(refused("chapter-not-found")).toBe("chapter-not-found");
    expect(refused("something-new")).toBe("unreachable");
    expect(chapterChangeError(new TypeError("Failed to fetch"))).toBe("unreachable");
    expect(canRetry("unreachable")).toBe(true);
    expect(canRetry("chapter-start")).toBe(false);
  });

  // A model of the flow: any run of events agrees with it step by step.
  it("never sends a title with a problem, and sends one key per request", () => {
    const anyEvent: fc.Arbitrary<SplitChapterEvent> = fc.oneof(
      fc.constant({ _tag: "Open" as const, messageId: M1 }),
      fc.constantFrom("", "  ", "Garden", "a".repeat(CHAPTER_TITLE_MAX + 1)).map((title) => ({
        _tag: "Edit" as const,
        title,
      })),
      fc.integer({ min: 1, max: 99 }).map((n) => ({ _tag: "Send" as const, key: ChapterId.make(`k${n}`) })),
      fc.constantFrom("unreachable" as const, "moved" as const).map((error) => ({ _tag: "Failed" as const, error })),
      fc.constant({ _tag: "Close" as const }),
    );
    fc.assert(
      fc.property(fc.array(anyEvent, { maxLength: 30 }), (events) => {
        let state: SplitChapter = SPLIT_CLOSED;
        let key: ChapterId | null = null;
        for (const event of events) {
          const before = state;
          state = splitStep(state, event);
          if (state.step === "splitting") {
            expect(titleProblem(state.title)).toBeNull();
            // A try again of a failed split, unchanged, keeps the key it was sent under.
            if (before.step === "failed") expect(state.key).toBe(key);
            key = state.key;
          }
          if (event._tag === "Close") expect(state).toBe(SPLIT_CLOSED);
        }
      }),
    );
  });
});

describe("Merge with previous", () => {
  it("merges one chapter at a time, and a failure waits to be tried again or dismissed", () => {
    const merging = mergeStep(MERGE_IDLE, { _tag: "Merge", chapterId: C1 });
    expect(merging).toEqual({ step: "merging", chapterId: C1 });
    expect(mergeStep(merging, { _tag: "Merge", chapterId: K1 })).toBe(merging);
    expect(mergeStep(merging, { _tag: "Merged" })).toBe(MERGE_IDLE);
    const failed = mergeStep(merging, { _tag: "Failed", error: "first-chapter" });
    expect(failed).toEqual({ step: "failed", chapterId: C1, error: "first-chapter" });
    expect(mergeStep(failed, { _tag: "Dismiss" })).toBe(MERGE_IDLE);
    expect(mergeStep(failed, { _tag: "Merge", chapterId: C1 })).toEqual(merging);
  });

  it("agrees with its model for any run of events", () => {
    const anyEvent: fc.Arbitrary<MergeChapterEvent> = fc.oneof(
      fc.constantFrom(C1, K1).map((chapterId) => ({ _tag: "Merge" as const, chapterId })),
      fc.constant({ _tag: "Merged" as const }),
      fc.constant({ _tag: "Failed" as const, error: "unreachable" as const }),
      fc.constant({ _tag: "Dismiss" as const }),
    );
    fc.assert(
      fc.property(fc.array(anyEvent, { maxLength: 30 }), (events) => {
        let state = MERGE_IDLE;
        for (const event of events) {
          const before = state.step;
          state = mergeStep(state, event);
          const expected =
            event._tag === "Merge"
              ? "merging"
              : before !== "merging"
                ? event._tag === "Dismiss" && before === "failed"
                  ? "idle"
                  : before
                : event._tag === "Merged"
                  ? "idle"
                  : event._tag === "Failed"
                    ? "failed"
                    : before;
          expect(state.step).toBe(expected);
        }
      }),
    );
  });
});
