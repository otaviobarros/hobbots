import { ThreadId } from "@hobbots/domain";
import { describe, expect, it } from "vitest";
import { CATCH_UP_START, type CatchUpEvent, type CatchUpFlow, catchUpStep } from "./catch-up-flow.ts";

// Issue #1387 (ADR 037): a visit to an unread chat reads its catch-up once; watching it does not.

const A = ThreadId.make("a");
const B = ThreadId.make("b");
const see = (threadId: ThreadId | undefined, shown: boolean, unread: boolean): CatchUpEvent => ({
  _tag: "See",
  threadId,
  shown,
  unread,
});
const run = (events: ReadonlyArray<CatchUpEvent>, from: CatchUpFlow = CATCH_UP_START) =>
  events.reduce(catchUpStep, from);

describe("catch-up visits", () => {
  it("[TC-CH-1387-27] starts a visit on arriving at an unread chat in view, and none while you watch it", () => {
    const visit = run([see(undefined, true, false), see(A, true, true)]);
    expect(visit).toMatchObject({ step: "open", threadId: A, visits: 1 });
    // The chat marks itself read and replies land while you watch: still the same visit.
    expect(run([see(A, true, false), see(A, true, true)], visit)).toBe(visit);
    expect(run([{ _tag: "Fold" }], visit)).toMatchObject({ step: "folded", visits: 1 });
  });

  it("[TC-CH-1387-28] starts a new visit when you come back to it unread, and none in a chat that is read", () => {
    const first = run([see(A, true, true), { _tag: "Fold" }]);
    const away = run([see(A, false, false)], first);
    expect(away).toMatchObject({ step: "folded", visits: 1 });
    expect(run([see(A, true, true)], away)).toMatchObject({ step: "open", visits: 2 });
    expect(run([see(A, true, false)], away)).toMatchObject({ step: "folded", visits: 1 });
    expect(run([see(B, true, false)], away)).toMatchObject({ step: "idle", threadId: B });
    // A chat behind another window is no visit until it comes to the front.
    expect(run([see(B, false, true)], away)).toMatchObject({ step: "idle" });
  });
});
