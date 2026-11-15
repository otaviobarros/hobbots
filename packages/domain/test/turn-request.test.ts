import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  type Actor,
  AgentId,
  HOB_RELAY_BUDGET,
  IllegalTurnRequestTransition,
  lineKey,
  MessageId,
  mainLine,
  RESUMED_RELAY_DEPTH,
  relayDepthAfter,
  relayStateFor,
  ChannelId,
  TurnRequest,
  type TurnRequestEvent,
  TurnRequestId,
  type TurnRequestState,
  TurnRequestState as TurnRequestStates,
  TurnRequests,
} from "../src/index.ts";
import { agreesWithModel } from "../testing/machine-model.ts";

// Issue #1461 (ADR 039, One hob speaks at a time): each answer a hob owes is a TurnRequest, and a
// conversation gives its floor to one at a time, the oldest waiting first.

const at = "2026-11-14T10:00:00.000Z";
const CHANNEL = ChannelId.make("camp");
const HOBS = ["quill", "pip", "rook"].map((id) => AgentId.make(id));
const PEOPLE: ReadonlyArray<Actor> = [
  { kind: "user", id: "owner" },
  { kind: "user", id: "marina" },
];

const request = (state: TurnRequestState, over: Partial<TurnRequest> = {}) =>
  new TurnRequest({
    id: TurnRequestId.make("r-1"),
    channelId: CHANNEL,
    rootMessageId: null,
    hobId: HOBS[0] as AgentId,
    messageId: MessageId.make("m-1"),
    causedBy: PEOPLE[0] as Actor,
    cause: "mention",
    relayDepth: 0,
    state,
    replyId: state === "waiting" || state === "paused" ? null : MessageId.make("reply-0"),
    droppedBy: null,
    queuedAt: 1,
    position: 0,
    createdAt: at,
    ...over,
  });

// The rules of ADR 039, written apart from the machine so the two can disagree.
interface RequestView {
  readonly state: TurnRequestState;
  readonly replyId: string | null;
  readonly droppedBy: Actor | null;
  readonly relayDepth: number;
  readonly passReason: string | null;
}
const view = (r: TurnRequest): RequestView => ({
  state: r.state,
  replyId: r.replyId,
  droppedBy: r.droppedBy,
  relayDepth: r.relayDepth,
  passReason: r.passReason,
});
const stepModel = (m: RequestView, e: TurnRequestEvent): RequestView | "refused" => {
  switch (e._tag) {
    case "Speak":
      return m.state === "waiting" ? { ...m, state: "speaking", replyId: e.replyId } : "refused";
    case "Answer":
      return m.state === "speaking" ? { ...m, state: "answered", passReason: null } : "refused";
    case "Pass":
      return m.state === "speaking" ? { ...m, state: "passed", passReason: e.reason } : "refused";
    case "Drop":
      return m.state === "waiting" || m.state === "paused" || m.state === "speaking"
        ? { ...m, state: "dropped", droppedBy: e.by, passReason: null }
        : "refused";
    case "GoOn":
      return m.state === "paused" ? { ...m, state: "waiting", relayDepth: 1 } : "refused";
  }
};

const by = fc.option(fc.constantFrom(...PEOPLE), { nil: null });
const events: fc.Arbitrary<TurnRequestEvent> = fc.oneof(
  fc.constantFrom("reply-1", "reply-2").map((id) => ({ _tag: "Speak", replyId: MessageId.make(id) }) as const),
  fc.constant({ _tag: "Answer" } as const),
  fc.constantFrom("Quill covered it", "Nothing to add").map((reason) => ({ _tag: "Pass", reason }) as const),
  by.map((actor) => ({ _tag: "Drop", by: actor }) as const),
  fc.constant({ _tag: "GoOn" } as const),
);

describe("TurnRequestMachine", () => {
  // covers ADR 039 (One hob speaks at a time)
  it("agrees with a model of speaking, answering, passing, dropping and going on over random runs (#1461)", () => {
    agreesWithModel({
      machine: TurnRequests,
      records: fc
        .record({
          state: fc.constantFrom(...TurnRequestStates.literals),
          depth: fc.integer({ min: 0, max: 6 }),
          passReason: fc.constantFrom(null, "Quill covered it"),
        })
        .map(({ state, depth, passReason }) =>
          request(state, {
            relayDepth: depth,
            passReason: state === "speaking" || state === "passed" ? passReason : null,
          }),
        ),
      events,
      model: { init: view, step: stepModel, view },
      isError: (result): result is IllegalTurnRequestTransition => result instanceof IllegalTurnRequestTransition,
    });
  });

  it("keys a thread apart from its channel's main line (#1461)", () => {
    expect(lineKey(mainLine(CHANNEL))).toBe("camp");
    expect(lineKey({ channelId: CHANNEL, rootMessageId: MessageId.make("m-9") })).toBe("camp/m-9");
  });
});

// The floor, played over three hobs: people send messages that mention some of them, the hob
// speaking mentions others, turns start and end, Stop and Stop all, hobs that cannot speak for now,
// and restarts. The records, moved only by the machine and the floor's rules, must agree with a
// model of a queue after every step.

type Op =
  | { readonly _tag: "Send"; readonly from: Actor; readonly hobs: ReadonlyArray<AgentId> }
  | { readonly _tag: "Relay"; readonly hobs: ReadonlyArray<AgentId> }
  | { readonly _tag: "Start"; readonly away: ReadonlyArray<AgentId> }
  | { readonly _tag: "End" }
  | { readonly _tag: "Pass"; readonly reason: string }
  | { readonly _tag: "Stop"; readonly by: Actor }
  | { readonly _tag: "StopAll"; readonly by: Actor }
  | { readonly _tag: "GoOn" }
  | { readonly _tag: "Restart" };

const someHobs = fc.subarray(HOBS).chain((hobs) => fc.shuffledSubarray(hobs, { minLength: hobs.length }));
const person = fc.constantFrom(...PEOPLE);
const ops: fc.Arbitrary<Op> = fc.oneof(
  { weight: 3, arbitrary: fc.record({ from: person, hobs: someHobs }).map((o) => ({ _tag: "Send", ...o }) as const) },
  { weight: 2, arbitrary: someHobs.map((hobs) => ({ _tag: "Relay", hobs }) as const) },
  { weight: 3, arbitrary: fc.subarray(HOBS, { maxLength: 2 }).map((away) => ({ _tag: "Start", away }) as const) },
  { weight: 2, arbitrary: fc.constant({ _tag: "End" } as const) },
  {
    weight: 1,
    arbitrary: fc
      .constantFrom("Quill covered it", "Nothing to add")
      .map((reason) => ({ _tag: "Pass", reason }) as const),
  },
  { weight: 1, arbitrary: person.map((actor) => ({ _tag: "Stop", by: actor }) as const) },
  { weight: 1, arbitrary: person.map((actor) => ({ _tag: "StopAll", by: actor }) as const) },
  { weight: 1, arbitrary: fc.constant({ _tag: "GoOn" } as const) },
  { weight: 1, arbitrary: fc.constant({ _tag: "Restart" } as const) },
);

/** One owed answer as the model keeps it. */
interface Owed {
  readonly id: string;
  readonly hob: AgentId;
  /** The message that caused it: a person's, or the reply of the turn that mentioned the hob. */
  readonly cause: string;
  readonly byHob: boolean;
  readonly depth: number;
  readonly state: "waiting" | "paused" | "speaking" | "answered" | "passed" | "dropped";
  readonly reply: string | null;
  readonly droppedBy: Actor | null;
  readonly passReason: string | null;
}

/**
 * The model: a list in the order requests were made, each moved by the rules of ADR 039 alone. Hobs
 * may wake each other for 3 turns after a person speaks: a fourth relay waits for a person, who lets
 * them go on for 3 more turns, or speaks, which drops what waited.
 */
const modelStep = (owed: ReadonlyArray<Owed>, op: Op, n: number): ReadonlyArray<Owed> => {
  const speaking = owed.find((o) => o.state === "speaking");
  const made = (hobs: ReadonlyArray<AgentId>, cause: string, byHob: boolean, depth: number) =>
    hobs.map(
      (hob, i): Owed => ({
        id: `r-${n}-${i}`,
        hob,
        cause,
        byHob,
        depth,
        state: depth > 3 ? "paused" : "waiting",
        reply: null,
        droppedBy: null,
        passReason: null,
      }),
    );
  switch (op._tag) {
    case "Send":
      return [
        ...owed.map((o) => (o.state === "paused" ? { ...o, state: "dropped" as const, droppedBy: op.from } : o)),
        ...made(op.hobs, `m-${n}`, false, 0),
      ];
    case "GoOn":
      return owed.map((o) => (o.state === "paused" ? { ...o, state: "waiting", depth: 1 } : o));
    case "Relay":
      if (speaking === undefined) return owed;
      return [
        ...owed,
        ...made(
          op.hobs.filter((hob) => hob !== speaking.hob),
          speaking.reply ?? "",
          true,
          speaking.depth + 1,
        ),
      ];
    case "Start": {
      if (speaking !== undefined) return owed;
      const next = owed.find((o) => o.state === "waiting" && !op.away.includes(o.hob));
      return owed.map((o) => (o === next ? { ...o, state: "speaking", reply: `reply-${n}` } : o));
    }
    case "End":
    case "Restart":
      return owed.map((o) => (o.state === "speaking" ? { ...o, state: "answered" } : o));
    // The hob speaking ended its turn with no message: the floor moves on as after a reply.
    case "Pass":
      return owed.map((o) => (o.state === "speaking" ? { ...o, state: "passed", passReason: op.reason } : o));
    case "Stop":
      if (speaking === undefined) return owed;
      return owed.map((o) =>
        o === speaking || ((o.state === "waiting" || o.state === "paused") && o.cause === speaking.reply)
          ? { ...o, state: "dropped", droppedBy: op.by }
          : o,
      );
    case "StopAll":
      return owed.map((o) =>
        o.state === "waiting" || o.state === "paused" || o.state === "speaking"
          ? { ...o, state: "dropped", droppedBy: op.by }
          : o,
      );
  }
};

/** The floor as the hub runs it: records moved only through `TurnRequests`. */
const floorStep = (records: ReadonlyArray<TurnRequest>, op: Op, n: number): ReadonlyArray<TurnRequest> => {
  const moved = (picked: ReadonlyArray<TurnRequest>, event: TurnRequestEvent) =>
    records.map((r) => {
      if (!picked.includes(r)) return r;
      const next = TurnRequests.transition(r, event);
      if (!(next instanceof TurnRequest)) throw new Error(`refused ${event._tag} at ${r.state}`);
      return next;
    });
  const speaking = TurnRequests.speaking(records);
  const made = (hobs: ReadonlyArray<AgentId>, messageId: MessageId, causedBy: Actor, depth: number) =>
    hobs.map(
      (hobId, position) =>
        new TurnRequest({
          id: TurnRequestId.make(`r-${n}-${position}`),
          channelId: CHANNEL,
          rootMessageId: null,
          hobId,
          messageId,
          causedBy,
          cause: causedBy.kind === "hob" ? "relay" : "mention",
          relayDepth: depth,
          state: relayStateFor(depth),
          replyId: null,
          droppedBy: null,
          // The revision of the message that caused them, which only grows.
          queuedAt: n,
          position,
          createdAt: at,
        }),
    );
  switch (op._tag) {
    case "Send":
      return [
        ...moved(TurnRequests.paused(records), { _tag: "Drop", by: op.from }),
        ...made(op.hobs, MessageId.make(`m-${n}`), op.from, 0),
      ];
    case "GoOn":
      return moved(TurnRequests.paused(records), { _tag: "GoOn" });
    case "Relay":
      if (speaking === null || speaking.replyId === null) return records;
      return [
        ...records,
        ...made(
          op.hobs.filter((hob) => hob !== speaking.hobId),
          speaking.replyId,
          { kind: "hob", id: speaking.hobId },
          relayDepthAfter([speaking]),
        ),
      ];
    case "Start": {
      const next = TurnRequests.next(records, (r) => !op.away.includes(r.hobId));
      return next === null ? records : moved([next], { _tag: "Speak", replyId: MessageId.make(`reply-${n}`) });
    }
    case "End":
    case "Restart":
      return speaking === null ? records : moved([speaking], { _tag: "Answer" });
    case "Pass":
      return speaking === null ? records : moved([speaking], { _tag: "Pass", reason: op.reason });
    case "Stop":
      return moved(TurnRequests.stopping(records), { _tag: "Drop", by: op.by });
    case "StopAll":
      return moved(TurnRequests.stoppingAll(records), { _tag: "Drop", by: op.by });
  }
};

const shownModel = (owed: ReadonlyArray<Owed>) =>
  owed.map((o) => ({
    id: o.id,
    hob: o.hob,
    state: o.state,
    depth: o.depth,
    droppedBy: o.droppedBy,
    passReason: o.passReason,
  }));
const shownFloor = (records: ReadonlyArray<TurnRequest>) =>
  records
    .toSorted((a, b) => a.queuedAt - b.queuedAt || a.position - b.position)
    .map((r) => ({
      id: r.id,
      hob: r.hobId,
      state: r.state,
      depth: r.relayDepth,
      droppedBy: r.droppedBy,
      passReason: r.passReason,
    }));

describe("the floor", () => {
  // covers ADR 039 (One hob speaks at a time)
  it("agrees with a model of the floor across three hobs, whatever sends, mentions, passes, stops and restarts do (#1461)", () => {
    fc.assert(
      fc.property(fc.array(ops, { maxLength: 40 }), (script) => {
        let owed: ReadonlyArray<Owed> = [];
        let records: ReadonlyArray<TurnRequest> = [];
        script.forEach((op, i) => {
          const n = i + 1;
          owed = modelStep(owed, op, n);
          records = floorStep(records, op, n);
          expect(shownFloor(records)).toEqual(shownModel(owed));
          // One hob at most holds the floor, and those waiting keep their order.
          expect(records.filter(TurnRequests.isSpeaking).length).toBeLessThanOrEqual(1);
          expect(TurnRequests.waiting(records).map((r) => r.id)).toEqual(
            owed.filter((o) => o.state === "waiting").map((o) => o.id),
          );
        });
      }),
      { numRuns: 500 },
    );
  });

  it("gives the floor to the message Send now picked, and to nobody while a hob speaks (#1461)", () => {
    const [quill, pip] = HOBS as [AgentId, AgentId];
    const first = request("waiting", { id: TurnRequestId.make("a"), hobId: quill });
    const picked = request("waiting", {
      id: TurnRequestId.make("b"),
      hobId: pip,
      messageId: MessageId.make("m-2"),
      queuedAt: 2,
    });
    expect(TurnRequests.next([first, picked])).toBe(first);
    expect(TurnRequests.next([first, picked], undefined, MessageId.make("m-2"))).toBe(picked);
    expect(TurnRequests.next([first, picked], (r) => r.hobId !== quill)).toBe(picked);
    expect(TurnRequests.next([request("speaking", { id: TurnRequestId.make("c") }), first])).toBeNull();
  });

  it("keeps what a person asked for when Stop drops the speaking turn and the hand-offs it set off (#1461)", () => {
    const [quill, pip, rook] = HOBS as [AgentId, AgentId, AgentId];
    const speaking = request("speaking", { id: TurnRequestId.make("s"), hobId: quill });
    const handOff = request("waiting", {
      id: TurnRequestId.make("h"),
      hobId: pip,
      messageId: MessageId.make("reply-0"),
      causedBy: { kind: "hob", id: quill },
      cause: "relay",
      relayDepth: 1,
      queuedAt: 2,
    });
    const paused = request("paused", { ...handOff, id: TurnRequestId.make("p"), hobId: rook, position: 1 });
    const asked = request("waiting", { id: TurnRequestId.make("a"), hobId: rook, queuedAt: 3 });
    expect(TurnRequests.stopping([speaking, handOff, paused, asked]).map((r) => r.id)).toEqual(["s", "h", "p"]);
    expect(TurnRequests.stopping([handOff, asked])).toEqual([]);
    expect(TurnRequests.stoppingAll([speaking, handOff, paused, asked]).map((r) => r.id)).toEqual(["s", "h", "p", "a"]);
  });
});

describe("the relay budget", () => {
  const [quill, pip] = HOBS as [AgentId, AgentId];

  // covers ADR 039 (Hobs talking to hobs)
  it("lets hobs wake each other for 3 turns after a person speaks, and pauses the fourth (#1463)", () => {
    expect(HOB_RELAY_BUDGET).toBe(3);
    // A person's message is depth 0; each hob's mention adds one to the turn that mentioned.
    const depths = [0];
    for (let turn = 0; turn < 4; turn++) {
      const answered = request("speaking", { relayDepth: depths.at(-1) as number });
      depths.push(relayDepthAfter([answered]));
    }
    expect(depths).toEqual([0, 1, 2, 3, 4]);
    expect(depths.map(relayStateFor)).toEqual(["waiting", "waiting", "waiting", "waiting", "paused"]);
    // A turn nobody asked for, as a backpack continuation, starts the count at its first relay.
    expect(relayDepthAfter([])).toBe(1);
    // A turn that answered several requests counts from the deepest.
    expect(relayDepthAfter([request("speaking", { relayDepth: 2 }), request("speaking", { relayDepth: 0 })])).toBe(3);
  });

  it("lets the paused hobs go on for exactly the budget's turns again, the resumed one first (#1463)", () => {
    const paused = request("paused", { relayDepth: HOB_RELAY_BUDGET + 1, causedBy: { kind: "hob", id: pip } });
    const resumed = TurnRequests.transition(paused, { _tag: "GoOn" });
    if (!(resumed instanceof TurnRequest)) throw new Error("GoOn refused");
    expect([resumed.state, resumed.relayDepth]).toEqual(["waiting", RESUMED_RELAY_DEPTH]);
    // The resumed turn and the two relays after it run; the next waits for a person again.
    let depth = resumed.relayDepth;
    const states = [relayStateFor(depth)];
    for (let turn = 0; turn < 3; turn++) {
      depth = relayDepthAfter([request("speaking", { relayDepth: depth })]);
      states.push(relayStateFor(depth));
    }
    expect(states).toEqual(["waiting", "waiting", "waiting", "paused"]);
    // Only a paused request goes on.
    expect(TurnRequests.transition(request("waiting"), { _tag: "GoOn" })).toBeInstanceOf(IllegalTurnRequestTransition);
  });

  it("names the hobs a paused relay is between, each once, and none while nothing is paused (#1463)", () => {
    const fromPip = request("paused", {
      id: TurnRequestId.make("p1"),
      hobId: quill,
      causedBy: { kind: "hob", id: pip },
      relayDepth: 4,
    });
    const fromQuill = request("paused", {
      id: TurnRequestId.make("p2"),
      hobId: pip,
      causedBy: { kind: "hob", id: quill },
      relayDepth: 4,
      queuedAt: 2,
    });
    expect(TurnRequests.pausedHobs([fromPip, fromQuill])).toEqual([pip, quill]);
    expect(TurnRequests.pausedHobs([request("waiting"), request("speaking")])).toEqual([]);
    expect(TurnRequests.paused([fromQuill, request("waiting"), fromPip]).map((r) => r.id)).toEqual(["p1", "p2"]);
  });
});
