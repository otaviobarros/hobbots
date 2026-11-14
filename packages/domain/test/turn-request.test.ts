import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  type Actor,
  AgentId,
  IllegalTurnRequestTransition,
  lineKey,
  MessageId,
  mainLine,
  ThreadId,
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
const THREAD = ThreadId.make("camp");
const HOBS = ["quill", "pip", "rook"].map((id) => AgentId.make(id));
const PEOPLE: ReadonlyArray<Actor> = [
  { kind: "user", id: "owner" },
  { kind: "user", id: "marina" },
];

const request = (state: TurnRequestState, over: Partial<TurnRequest> = {}) =>
  new TurnRequest({
    id: TurnRequestId.make("r-1"),
    threadId: THREAD,
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
}
const view = (r: TurnRequest): RequestView => ({ state: r.state, replyId: r.replyId, droppedBy: r.droppedBy });
const stepModel = (m: RequestView, e: TurnRequestEvent): RequestView | "refused" => {
  switch (e._tag) {
    case "Speak":
      return m.state === "waiting" ? { ...m, state: "speaking", replyId: e.replyId } : "refused";
    case "Answer":
      return m.state === "speaking" ? { ...m, state: "answered" } : "refused";
    case "Pass":
      return m.state === "speaking" ? { ...m, state: "passed" } : "refused";
    case "Drop":
      return m.state === "waiting" || m.state === "paused" || m.state === "speaking"
        ? { ...m, state: "dropped", droppedBy: e.by }
        : "refused";
  }
};

const by = fc.option(fc.constantFrom(...PEOPLE), { nil: null });
const events: fc.Arbitrary<TurnRequestEvent> = fc.oneof(
  fc.constantFrom("reply-1", "reply-2").map((id) => ({ _tag: "Speak", replyId: MessageId.make(id) }) as const),
  fc.constant({ _tag: "Answer" } as const),
  fc.constant({ _tag: "Pass" } as const),
  by.map((actor) => ({ _tag: "Drop", by: actor }) as const),
);

describe("TurnRequestMachine", () => {
  // covers ADR 039 (One hob speaks at a time)
  it("[TC-DM-1461-01] agrees with a model of speaking, answering, passing and dropping over random runs", () => {
    agreesWithModel({
      machine: TurnRequests,
      records: fc.constantFrom(...TurnRequestStates.literals).map((state) => request(state)),
      events,
      model: { init: view, step: stepModel, view },
      isError: (result): result is IllegalTurnRequestTransition => result instanceof IllegalTurnRequestTransition,
    });
  });

  it("[TC-DM-1461-02] keys a reply thread apart from its thread's main line", () => {
    expect(lineKey(mainLine(THREAD))).toBe("camp");
    expect(lineKey({ threadId: THREAD, rootMessageId: MessageId.make("m-9") })).toBe("camp/m-9");
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
  | { readonly _tag: "Stop"; readonly by: Actor }
  | { readonly _tag: "StopAll"; readonly by: Actor }
  | { readonly _tag: "Restart" };

const someHobs = fc.subarray(HOBS).chain((hobs) => fc.shuffledSubarray(hobs, { minLength: hobs.length }));
const person = fc.constantFrom(...PEOPLE);
const ops: fc.Arbitrary<Op> = fc.oneof(
  { weight: 3, arbitrary: fc.record({ from: person, hobs: someHobs }).map((o) => ({ _tag: "Send", ...o }) as const) },
  { weight: 2, arbitrary: someHobs.map((hobs) => ({ _tag: "Relay", hobs }) as const) },
  { weight: 3, arbitrary: fc.subarray(HOBS, { maxLength: 2 }).map((away) => ({ _tag: "Start", away }) as const) },
  { weight: 2, arbitrary: fc.constant({ _tag: "End" } as const) },
  { weight: 1, arbitrary: person.map((actor) => ({ _tag: "Stop", by: actor }) as const) },
  { weight: 1, arbitrary: person.map((actor) => ({ _tag: "StopAll", by: actor }) as const) },
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
  readonly state: "waiting" | "speaking" | "answered" | "dropped";
  readonly reply: string | null;
  readonly droppedBy: Actor | null;
}

/** The model: a list in the order requests were made, each moved by the rules of ADR 039 alone. */
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
        state: "waiting",
        reply: null,
        droppedBy: null,
      }),
    );
  switch (op._tag) {
    case "Send":
      return [...owed, ...made(op.hobs, `m-${n}`, false, 0)];
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
    case "Stop":
      if (speaking === undefined) return owed;
      return owed.map((o) =>
        o === speaking || (o.state === "waiting" && o.cause === speaking.reply)
          ? { ...o, state: "dropped", droppedBy: op.by }
          : o,
      );
    case "StopAll":
      return owed.map((o) =>
        o.state === "waiting" || o.state === "speaking" ? { ...o, state: "dropped", droppedBy: op.by } : o,
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
          threadId: THREAD,
          rootMessageId: null,
          hobId,
          messageId,
          causedBy,
          cause: causedBy.kind === "hob" ? "relay" : "mention",
          relayDepth: depth,
          state: "waiting",
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
      return [...records, ...made(op.hobs, MessageId.make(`m-${n}`), op.from, 0)];
    case "Relay":
      if (speaking === null || speaking.replyId === null) return records;
      return [
        ...records,
        ...made(
          op.hobs.filter((hob) => hob !== speaking.hobId),
          speaking.replyId,
          { kind: "hob", id: speaking.hobId },
          speaking.relayDepth + 1,
        ),
      ];
    case "Start": {
      const next = TurnRequests.next(records, (r) => !op.away.includes(r.hobId));
      return next === null ? records : moved([next], { _tag: "Speak", replyId: MessageId.make(`reply-${n}`) });
    }
    case "End":
    case "Restart":
      return speaking === null ? records : moved([speaking], { _tag: "Answer" });
    case "Stop":
      return moved(TurnRequests.stopping(records), { _tag: "Drop", by: op.by });
    case "StopAll":
      return moved(TurnRequests.stoppingAll(records), { _tag: "Drop", by: op.by });
  }
};

const shownModel = (owed: ReadonlyArray<Owed>) =>
  owed.map((o) => ({ id: o.id, hob: o.hob, state: o.state, depth: o.depth, droppedBy: o.droppedBy }));
const shownFloor = (records: ReadonlyArray<TurnRequest>) =>
  records
    .toSorted((a, b) => a.queuedAt - b.queuedAt || a.position - b.position)
    .map((r) => ({ id: r.id, hob: r.hobId, state: r.state, depth: r.relayDepth, droppedBy: r.droppedBy }));

describe("the floor", () => {
  // covers ADR 039 (One hob speaks at a time)
  it("[TC-DM-1461-03] agrees with a model of the floor across three hobs, whatever sends, mentions, stops and restarts do", () => {
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

  it("[TC-DM-1461-04] gives the floor to the message Send now picked, and to nobody while a hob speaks", () => {
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

  it("[TC-DM-1461-05] keeps what a person asked for when Stop drops the speaking turn and the hand-offs it set off", () => {
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
