import { THREAD_TITLE_MAX, ThreadId } from "@hobbots/domain";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { ApiError } from "../../api/client.ts";
import {
  type CampDraft,
  campPayload,
  campProblems,
  type MakeCamp,
  type MakeCampEvent,
  makeCampError,
  makeCampStep,
  startMakeCamp,
} from "./make-camp-flow.ts";

const draft = (change: Partial<CampDraft> = {}): CampDraft => ({
  title: "2027 taxes",
  goal: "",
  private: false,
  ...change,
});
const K1 = ThreadId.make("k1");
const K2 = ThreadId.make("k2");

const run = (events: ReadonlyArray<MakeCampEvent>, from: MakeCamp = startMakeCamp()) =>
  events.reduce(makeCampStep, from);

describe("Make a camp", () => {
  it("checks the name and goal as the hub does: trimmed, named, and within their lengths", () => {
    expect(campProblems(draft())).toEqual({});
    expect(campProblems(draft({ title: "   " }))).toEqual({ title: "title-missing" });
    expect(campProblems(draft({ title: "x".repeat(THREAD_TITLE_MAX + 1) }))).toEqual({ title: "title-long" });
    expect(campProblems(draft({ title: ` ${"x".repeat(THREAD_TITLE_MAX)} ` }))).toEqual({});
    expect(campProblems(draft({ goal: "g".repeat(501) }))).toEqual({ goal: "goal-long" });
  });

  it("sends a trimmed camp, with no goal when the goal is blank", () => {
    expect(campPayload(draft({ title: " Taxes ", goal: "  " }), K1)).toEqual({
      key: K1,
      title: "Taxes",
      goal: null,
      private: false,
    });
    expect(campPayload(draft({ goal: " File on time ", private: true }), K1)).toMatchObject({
      goal: "File on time",
      private: true,
    });
  });

  it("shows a field's problem once it lost focus, and every problem once a send finds one", () => {
    const empty = run([{ _tag: "Edit", draft: draft({ title: "" }) }]);
    expect(empty).toMatchObject({ step: "editing", shown: new Set() });
    expect(run([{ _tag: "Leave", field: "title" }], empty)).toMatchObject({ shown: new Set(["title"]) });
    expect(run([{ _tag: "Send", key: K1 }], empty)).toMatchObject({
      step: "editing",
      shown: new Set(["title", "goal", "private"]),
    });
  });

  it("keeps the key and what you typed when a failed camp is tried again, and a new key once you edit", () => {
    const failed = run([
      { _tag: "Edit", draft: draft() },
      { _tag: "Send", key: K1 },
      { _tag: "Failed", error: "unreachable" },
    ]);
    expect(failed).toEqual({ step: "failed", draft: draft(), key: K1, error: "unreachable" });
    expect(run([{ _tag: "Send", key: K2 }], failed)).toEqual({ step: "saving", draft: draft(), key: K1 });
    const edited = run([{ _tag: "Edit", draft: draft({ title: "Taxes" }) }], failed);
    expect(run([{ _tag: "Send", key: K2 }], edited)).toEqual({
      step: "saving",
      draft: draft({ title: "Taxes" }),
      key: K2,
    });
  });

  it("tells a paused or retired hob from a request that got no answer", () => {
    expect(makeCampError(new ApiError("", "HobUnavailable"))).toBe("hob-unavailable");
    expect(makeCampError(new ApiError("", "ThreadKeyReused"))).toBe("unreachable");
    expect(makeCampError(new TypeError("Failed to fetch"))).toBe("unreachable");
  });

  // A model of the flow: any run of events agrees with it step by step.
  it("agrees with its model for any run of events", () => {
    const anyDraft = fc.record({
      title: fc.constantFrom("", "  ", "Taxes", " Lisbon trip ", "x".repeat(THREAD_TITLE_MAX + 1)),
      goal: fc.constantFrom("", "File on time", "g".repeat(501)),
      private: fc.boolean(),
    });
    const anyEvent: fc.Arbitrary<MakeCampEvent> = fc.oneof(
      anyDraft.map((each) => ({ _tag: "Edit" as const, draft: each })),
      fc.constantFrom("title", "goal", "private").map((field) => ({ _tag: "Leave" as const, field })),
      fc.integer({ min: 1, max: 99 }).map((n) => ({ _tag: "Send" as const, key: ThreadId.make(`k${n}`) })),
      fc.constantFrom("hob-unavailable", "unreachable").map((error) => ({ _tag: "Failed" as const, error })),
    );
    fc.assert(
      fc.property(fc.array(anyEvent, { maxLength: 30 }), (events) => {
        let state = startMakeCamp();
        // The model: what is typed, the key in flight or last failed, and whether a request is out.
        let typed = state.draft;
        let key: ThreadId | null = null;
        let saving = false;
        let failed = false;
        for (const event of events) {
          state = makeCampStep(state, event);
          if (event._tag === "Edit" && !saving) {
            typed = event.draft;
            failed = false;
            key = null;
          }
          if (event._tag === "Send" && !saving && Object.keys(campProblems(typed)).length === 0) {
            key = failed ? key : event.key;
            saving = true;
            failed = false;
          }
          if (event._tag === "Failed" && saving) {
            saving = false;
            failed = true;
          }
          expect(state.draft).toEqual(typed);
          expect(state.step).toBe(saving ? "saving" : failed ? "failed" : "editing");
          // A camp with a problem is never sent, and a request keeps one key until you edit.
          if (state.step !== "editing") {
            expect(campProblems(state.draft)).toEqual({});
            expect(state.key).toBe(key);
          }
        }
      }),
    );
  });
});
