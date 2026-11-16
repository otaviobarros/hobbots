import { ChannelId } from "@hobbots/domain";
import { describe, expect, it } from "vitest";
import { CATCH_UP_START, type CatchUpEvent, type CatchUpFlow, catchUpStep, seeing } from "./catch-up-flow.ts";

// Issue #1387 (ADR 037): a visit to an unread chat reads its catch-up once; watching it does not.

const A = ChannelId.make("a");
const B = ChannelId.make("b");
const see = (channelId: ChannelId | undefined, shown: boolean, unread: boolean): CatchUpEvent => ({
  _tag: "See",
  channelId,
  shown,
  unread,
});
const run = (events: ReadonlyArray<CatchUpEvent>, from: CatchUpFlow = CATCH_UP_START) =>
  events.reduce(catchUpStep, from);

describe("catch-up visits", () => {
  it("starts a visit on arriving at an unread chat in view, and none while you watch it (#1387)", () => {
    const visit = run([see(undefined, true, false), see(A, true, true)]);
    expect(visit).toMatchObject({ step: "open", channelId: A, visits: 1 });
    // The chat marks itself read and replies land while you watch: still the same visit.
    expect(run([see(A, true, false), see(A, true, true)], visit)).toBe(visit);
    expect(run([{ _tag: "Fold" }], visit)).toMatchObject({ step: "folded", visits: 1 });
  });

  it("starts a new visit when you come back to it unread, and none in a chat that is read (#1387)", () => {
    const first = run([see(A, true, true), { _tag: "Fold" }]);
    const away = run([see(A, false, false)], first);
    expect(away).toMatchObject({ step: "folded", visits: 1 });
    expect(run([see(A, true, true)], away)).toMatchObject({ step: "open", visits: 2 });
    expect(run([see(A, true, false)], away)).toMatchObject({ step: "folded", visits: 1 });
    expect(run([see(B, true, false)], away)).toMatchObject({ step: "idle", channelId: B });
    // A chat behind another window is no visit until it comes to the front.
    expect(run([see(B, false, true)], away)).toMatchObject({ step: "idle" });
  });

  // covers ADR 039 (Members: the unread line is per person)
  it("waits for your unread channels before a visit, so a chat that loads first still gets its catch-up (#1454)", () => {
    // You open the unread chat by its address: the chat loads before your unread channels do.
    const early = run([seeing(A, true, undefined)]);
    expect(early).toMatchObject({ step: "idle", channelId: undefined, visits: 0 });
    // Once they arrive the visit starts, so catch-up is read before the chat marks itself read.
    expect(run([seeing(A, true, new Set([A]))], early)).toMatchObject({ step: "open", channelId: A, visits: 1 });
    // A chat that turns out read starts nothing.
    expect(run([seeing(A, true, new Set())], early)).toMatchObject({ step: "idle", channelId: A, visits: 0 });
  });
});
