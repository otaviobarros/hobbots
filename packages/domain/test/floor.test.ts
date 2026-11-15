import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  type Actor,
  AgentId,
  decideFloor,
  type FloorAction,
  type FloorHob,
  type FloorPhase,
  type FloorSnapshot,
  MessageId,
  startsAtOnce,
  ThreadId,
  TurnRequest,
  TurnRequestId,
  type TurnRequestState,
  TurnRequests,
} from "../src/index.ts";

// Issue #1549 (ADR 039, One hob speaks at a time; ADR 019): who takes a line's floor next is one
// pure decision. The model below writes the rules apart from `decideFloor`, so the two can disagree,
// and the named examples are the review findings of #1527, so each bug class stays fixed.

const at = "2026-11-14T10:00:00.000Z";
const THREAD = ThreadId.make("camp");
const [QUILL, PIP, ROOK] = ["quill", "pip", "rook"].map((id) => AgentId.make(id)) as [AgentId, AgentId, AgentId];
const HOBS = [QUILL, PIP, ROOK];
const OWNER: Actor = { kind: "user", id: "owner" };

const request = (id: string, hobId: AgentId, over: Partial<TurnRequest> = {}) =>
  new TurnRequest({
    id: TurnRequestId.make(id),
    threadId: THREAD,
    rootMessageId: null,
    hobId,
    messageId: MessageId.make(`m-${id}`),
    causedBy: OWNER,
    cause: "mention",
    relayDepth: 0,
    state: "waiting",
    replyId: null,
    droppedBy: null,
    queuedAt: 1,
    position: 0,
    createdAt: at,
    ...over,
  });

const hob = (hobId: AgentId, over: Partial<FloorHob> = {}): FloorHob => ({
  hobId,
  available: true,
  member: true,
  held: false,
  work: false,
  progress: false,
  ...over,
});

const FREE: FloorPhase = { _tag: "Free" };
const carrying = (hobId: AgentId, over: { routineOnly?: boolean; late?: boolean } = {}): FloorPhase => ({
  _tag: "Carrying",
  hobId,
  routineOnly: over.routineOnly ?? false,
  late: over.late ?? false,
});

const snapshot = (over: Partial<FloorSnapshot> = {}): FloorSnapshot => ({
  phase: FREE,
  open: true,
  restoring: false,
  sent: null,
  backpack: true,
  requests: [],
  chosen: null,
  hobs: HOBS.map((id) => hob(id)),
  queued: false,
  ...over,
});

const hobsWith = (changes: Partial<Record<AgentId, Partial<FloorHob>>>) => HOBS.map((id) => hob(id, changes[id] ?? {}));

const start = (r: TurnRequest, carries = false): FloorAction => ({ _tag: "Start", request: r, carries });
const dispatch = (hobId: AgentId): FloorAction => ({ _tag: "Dispatch", hobId });
const IDLE: FloorAction = { _tag: "Idle" };

// The model: the rules of #1549 written as one hob's checklist after another, apart from `decideFloor`.

/** Floor order: the message Send now picked, then the message's revision, then its place among that message's requests. */
const modelOrder = (s: FloorSnapshot) => (a: TurnRequest, b: TurnRequest) => {
  const picked = (r: TurnRequest) => (r.messageId === s.chosen ? 0 : 1);
  return picked(a) - picked(b) || a.queuedAt - b.queuedAt || a.position - b.position;
};

type ModelDecision = { action: FloorAction; release: boolean };
const NOBODY: ModelDecision = { action: IDLE, release: false };

/** A hob's facts, its hold taken off when your queued message released them. */
const modelFacts = (s: FloorSnapshot, release: boolean) => (id: AgentId) => {
  const found = s.hobs.find((each) => each.hobId === id);
  return found === undefined ? undefined : { ...found, held: release ? false : found.held };
};

/** The first waiting request, in floor order, whose hob takes work now; none while one speaks. */
const modelNext = (s: FloorSnapshot): TurnRequest | null => {
  if (s.requests.some((r) => r.state === "speaking")) return null;
  const waiting = s.requests.filter((r) => r.state === "waiting").toSorted(modelOrder(s));
  const speaks = (r: TurnRequest) => {
    const f = s.hobs.find((each) => each.hobId === r.hobId);
    return f !== undefined && f.available && f.member;
  };
  return waiting.find(speaks) ?? null;
};

const modelDecide = (s: FloorSnapshot): ModelDecision => {
  if (!s.open) return NOBODY;
  // A request that speaks holds the floor: a free line has none, and no other turn starts beside it.
  if (s.phase._tag === "Free" && s.requests.some((r) => r.state === "speaking")) return NOBODY;
  const next = modelNext(s);
  // After a restore only the message you just sent starts, when it is next anyway, carrying nothing.
  if (s.restoring) {
    const yours = s.phase._tag === "Free" && s.sent !== null && next?.messageId === s.sent;
    return yours ? { action: start(next), release: false } : NOBODY;
  }
  if (s.phase._tag === "Carrying") return { action: modelCarrying(s, s.phase, next), release: false };
  const release = s.queued && s.hobs.some((each) => each.held);
  return { action: modelFree(s, modelFacts(s, release), next), release };
};

const mayCarry = (f: FloorHob | undefined) => f?.member === true && f.available && !f.held;

/** A dispatch's work: along its hob's request that is next, else a continuation, unless routine or late. */
const modelCarrying = (
  s: FloorSnapshot,
  phase: Extract<FloorPhase, { _tag: "Carrying" }>,
  next: TurnRequest | null,
) => {
  const { hobId, routineOnly, late } = phase;
  if (!mayCarry(modelFacts(s, false)(hobId))) return IDLE;
  if (next !== null && next.hobId === hobId) return start(next, true);
  return routineOnly || late ? IDLE : ({ _tag: "Continue", hobId } satisfies FloorAction);
};

/** A free floor: the next request, through a dispatch when its hob has work; else the first hob with work. */
const modelFree = (
  s: FloorSnapshot,
  facts: (id: AgentId) => FloorHob | undefined,
  next: TurnRequest | null,
): FloorAction => {
  if (next !== null) {
    const f = facts(next.hobId);
    const withWork = s.backpack && mayCarry(f) && (f?.work === true || f?.progress === true);
    return withWork ? dispatch(next.hobId) : start(next);
  }
  if (!s.backpack) return IDLE;
  const carrier = s.hobs.find((each) => mayCarry(facts(each.hobId)) && facts(each.hobId)?.work === true);
  return carrier === undefined ? IDLE : dispatch(carrier.hobId);
};

// Random snapshots: three hobs, a handful of requests in every state, every phase.

const states = fc.constantFrom<TurnRequestState>("waiting", "waiting", "waiting", "paused", "speaking", "answered");
const arbRequests = fc
  .array(fc.tuple(fc.constantFrom(...HOBS), states, fc.integer({ min: 1, max: 4 }), fc.integer({ min: 0, max: 2 })), {
    maxLength: 6,
  })
  .map((rows) => {
    // At most one request speaks, as the machine keeps it.
    let speaking = false;
    return rows.map(([hobId, state, queuedAt, position], i) => {
      const s = state === "speaking" && speaking ? "waiting" : state;
      if (s === "speaking") speaking = true;
      return request(`r-${i}`, hobId, {
        state: s,
        queuedAt,
        position,
        messageId: MessageId.make(`m-${queuedAt}`),
        replyId: s === "speaking" || s === "answered" ? MessageId.make(`reply-${i}`) : null,
      });
    });
  });
const arbHob = (hobId: AgentId) =>
  fc
    .record({
      available: fc.boolean(),
      member: fc.boolean(),
      held: fc.boolean(),
      work: fc.boolean(),
      progress: fc.boolean(),
    })
    .map((facts): FloorHob => ({ hobId, ...facts }));
const arbPhase: fc.Arbitrary<FloorPhase> = fc.oneof(
  fc.constant(FREE),
  fc
    .tuple(fc.constantFrom(...HOBS), fc.boolean(), fc.boolean())
    .map(([hobId, routineOnly, late]) => carrying(hobId, { routineOnly, late })),
);
const arbSnapshot: fc.Arbitrary<FloorSnapshot> = fc.record({
  phase: arbPhase,
  open: fc.constantFrom(true, true, true, true, false),
  restoring: fc.constantFrom(false, false, false, false, true),
  sent: fc.option(fc.constantFrom(...[1, 2, 3, 4].map((n) => MessageId.make(`m-${n}`))), { nil: null }),
  backpack: fc.boolean(),
  requests: arbRequests,
  chosen: fc.option(fc.constantFrom(...[1, 2, 3, 4].map((n) => MessageId.make(`m-${n}`))), { nil: null }),
  hobs: fc.tuple(arbHob(QUILL), arbHob(PIP), arbHob(ROOK)),
  queued: fc.boolean(),
});

describe("decideFloor", () => {
  // covers ADR 039 (One hob speaks at a time), ADR 019 (One wake path)
  it("agrees with a model of the floor for any line: requests, dispatch, holds per hob, availability, archive (#1549)", () => {
    fc.assert(
      fc.property(arbSnapshot, (s) => {
        expect(decideFloor(s)).toEqual(modelDecide(s));
      }),
      { numRuns: 2000 },
    );
  });

  it("never gives the floor to a hob that cannot take it, nor lets a held hob or an outsider carry work (#1549)", () => {
    fc.assert(
      fc.property(arbSnapshot, (s) => {
        const { action, release } = decideFloor(s);
        const facts = (id: AgentId) => s.hobs.find((each) => each.hobId === id);
        const held = (id: AgentId) => facts(id)?.held === true && !release;
        if (!s.open) expect(action).toEqual(IDLE);
        // After a restore only the message you just sent starts, and it carries nothing.
        if (s.restoring)
          expect(action._tag === "Idle" || (action._tag === "Start" && action.request.messageId === s.sent)).toBe(true);
        if (action._tag === "Start") {
          if (s.restoring) expect(action.carries).toBe(false);
          expect(action.request.state).toBe("waiting");
          expect(facts(action.request.hobId)).toMatchObject({ available: true, member: true });
          expect(s.requests.some(TurnRequests.isSpeaking)).toBe(false);
          // Work rides along only the request of the hob it is for.
          if (action.carries) expect(s.phase).toMatchObject({ _tag: "Carrying", hobId: action.request.hobId });
        }
        if (action._tag === "Dispatch" || action._tag === "Continue") {
          const id = action.hobId;
          expect(facts(id)).toMatchObject({ member: true, available: true });
          expect(held(id)).toBe(false);
          expect(s.backpack || action._tag === "Continue").toBe(true);
        }
        if (action._tag === "Continue") {
          expect(s.phase).toMatchObject({ _tag: "Carrying", hobId: action.hobId, routineOnly: false, late: false });
        }
        // Only your queued message on a free floor takes the work you stopped with it.
        if (release) expect(s.phase._tag === "Free" && s.queued).toBe(true);
      }),
      { numRuns: 2000 },
    );
  });

  // The #1527 findings, by group, each as the case that broke.

  describe("who goes next", () => {
    it("picks the oldest request before attaching backpack work, so work never moves a hob ahead (#1549)", () => {
      const older = request("a", QUILL, { queuedAt: 1 });
      const newer = request("b", PIP, { queuedAt: 2 });
      const s = snapshot({ requests: [newer, older], hobs: hobsWith({ [PIP]: { work: true } }) });
      expect(decideFloor(s).action).toEqual(start(older));
    });

    it("dispatches a member speaker's backpack work too, before its request starts (#1549)", () => {
      const asked = request("a", PIP);
      const s = snapshot({ requests: [asked], hobs: hobsWith({ [PIP]: { work: true } }) });
      expect(decideFloor(s).action).toEqual(dispatch(PIP));
      expect(decideFloor({ ...s, phase: carrying(PIP) }).action).toEqual(start(asked, true));
    });

    it("starts the next request after a dispatch that delivered nothing (#1549)", () => {
      const asked = request("a", QUILL);
      expect(decideFloor(snapshot({ requests: [asked] })).action).toEqual(start(asked));
    });

    it("checks the selected speaker's backpack, not the camp hob's, before admitting it at once (#1549)", () => {
      const asked = request("a", PIP);
      const s = snapshot({ requests: [asked], hobs: hobsWith({ [QUILL]: { work: true }, [PIP]: { progress: true } }) });
      expect(decideFloor(s).action).toEqual(dispatch(PIP));
    });

    it("gives the floor to Send now's pick ahead of older requests (#1549)", () => {
      const older = request("a", QUILL, { queuedAt: 1 });
      const picked = request("b", PIP, { queuedAt: 2 });
      expect(decideFloor(snapshot({ requests: [older, picked], chosen: picked.messageId })).action).toEqual(
        start(picked),
      );
    });

    it("never gives the floor to a hob that is not of the camp, as one that left it (#1549)", () => {
      const left = request("a", PIP, { queuedAt: 1 });
      const next = request("b", ROOK, { queuedAt: 2 });
      const s = snapshot({ requests: [left, next], hobs: hobsWith({ [PIP]: { member: false } }) });
      expect(decideFloor(s).action).toEqual(start(next));
      expect(decideFloor({ ...s, requests: [left] }).action).toEqual(IDLE);
    });

    it("gives the floor to nobody while a hob speaks, and carries nobody's work alongside (#1549)", () => {
      const speaking = request("s", QUILL, { state: "speaking", replyId: MessageId.make("reply") });
      const waiting = request("w", PIP, { queuedAt: 2 });
      const s = snapshot({ requests: [speaking, waiting], hobs: hobsWith({ [ROOK]: { work: true } }) });
      expect(decideFloor(s).action).toEqual(IDLE);
    });
  });

  describe("who can carry work", () => {
    it("skips a hob that cannot take work when picking a backpack carrier (#1549)", () => {
      const s = snapshot({
        hobs: hobsWith({ [QUILL]: { work: true, available: false }, [PIP]: { work: true } }),
      });
      expect(decideFloor(s).action).toEqual(dispatch(PIP));
    });

    it("dispatches only when a hob that can run has work, and leaves the floor idle otherwise (#1549)", () => {
      const s = snapshot({
        hobs: hobsWith({ [QUILL]: { work: true, held: true }, [PIP]: { work: true, member: false } }),
      });
      expect(decideFloor(s).action).toEqual(IDLE);
      expect(decideFloor(snapshot()).action).toEqual(IDLE);
    });

    it("lets routine progress ride only along a request of its own hob (#1549)", () => {
      const s = snapshot({ hobs: hobsWith({ [QUILL]: { progress: true } }) });
      expect(decideFloor(s).action).toEqual(IDLE);
      const other = request("a", PIP);
      expect(decideFloor({ ...s, requests: [other], phase: carrying(QUILL, { routineOnly: true }) }).action).toEqual(
        IDLE,
      );
    });

    it("starts a continuation for work that needs its hob, unless it went late meanwhile (#1549)", () => {
      expect(decideFloor(snapshot({ phase: carrying(QUILL) })).action).toEqual({ _tag: "Continue", hobId: QUILL });
      expect(decideFloor(snapshot({ phase: carrying(QUILL, { late: true }) })).action).toEqual(IDLE);
    });

    it("starts no turn for a dispatch whose hob paused, left or was held since it was planned (#1549)", () => {
      for (const change of [{ available: false }, { member: false }, { held: true }]) {
        expect(decideFloor(snapshot({ phase: carrying(PIP), hobs: hobsWith({ [PIP]: change }) })).action).toEqual(IDLE);
      }
    });
  });

  describe("holds", () => {
    it("applies a hold only to the hob whose work was stopped: another hob's work still runs (#1549)", () => {
      const s = snapshot({ hobs: hobsWith({ [QUILL]: { work: true, held: true }, [PIP]: { work: true } }) });
      expect(decideFloor(s).action).toEqual(dispatch(PIP));
    });

    it("starts a held hob's request without its work, which keeps waiting for you (#1549)", () => {
      const asked = request("a", QUILL);
      const s = snapshot({ requests: [asked], hobs: hobsWith({ [QUILL]: { work: true, held: true } }) });
      expect(decideFloor(s)).toEqual({ action: start(asked), release: false });
    });

    it("releases every hold for a queued message of yours, and its work goes along again (#1549)", () => {
      const asked = request("a", QUILL);
      const s = snapshot({
        requests: [asked],
        queued: true,
        hobs: hobsWith({ [QUILL]: { work: true, held: true }, [PIP]: { held: true } }),
      });
      expect(decideFloor(s)).toEqual({ action: dispatch(QUILL), release: true });
    });
  });

  describe("stop, removal and archive", () => {
    it("admits nothing in an archived thread, nor while the hub holds what waited after a restore (#1549)", () => {
      const asked = request("a", QUILL);
      const busy = { requests: [asked], hobs: hobsWith({ [QUILL]: { work: true } }) };
      expect(decideFloor(snapshot({ ...busy, open: false })).action).toEqual(IDLE);
      expect(decideFloor(snapshot({ ...busy, restoring: true })).action).toEqual(IDLE);
      expect(decideFloor(snapshot({ ...busy, open: false, phase: carrying(QUILL) })).action).toEqual(IDLE);
      expect(decideFloor(snapshot({ ...busy, restoring: true, phase: carrying(QUILL) })).action).toEqual(IDLE);
    });

    it("starts the message you send after a restore, in its turn and without the work that waited (#1549)", () => {
      const yours = request("a", QUILL);
      const held = { restoring: true, hobs: hobsWith({ [QUILL]: { work: true } }) };
      expect(decideFloor(snapshot({ ...held, requests: [yours], sent: yours.messageId })).action).toEqual(start(yours));
      const older = request("o", PIP, { queuedAt: 0, messageId: MessageId.make("m-older") });
      expect(decideFloor(snapshot({ ...held, requests: [older, yours], sent: yours.messageId })).action).toEqual(IDLE);
    });

    it("starts a message you send at once only when nothing is ahead of it and no work of its hob goes first (#1549)", () => {
      const yours = request("y", QUILL, { queuedAt: 9, messageId: MessageId.make("m-yours") });
      expect(startsAtOnce(snapshot(), yours)).toBe(true);
      // Behind a request whose hob can speak, it waits its turn.
      expect(startsAtOnce(snapshot({ requests: [request("a", PIP)] }), yours)).toBe(false);
      // Behind one whose hob cannot, it goes first.
      const paused = snapshot({ requests: [request("a", PIP)], hobs: hobsWith({ [PIP]: { available: false } }) });
      expect(startsAtOnce(paused, yours)).toBe(true);
      // Work of its hob, held until you wrote again, goes first through a dispatch.
      expect(startsAtOnce(snapshot({ hobs: hobsWith({ [QUILL]: { work: true, held: true } }) }), yours)).toBe(false);
      expect(startsAtOnce(snapshot({ hobs: hobsWith({ [QUILL]: { progress: true } }) }), yours)).toBe(false);
      // Its hob paused: it waits for the hob to wake.
      expect(startsAtOnce(snapshot({ hobs: hobsWith({ [QUILL]: { available: false } }) }), yours)).toBe(false);
      // After a restore it still starts, without the work that waited.
      expect(startsAtOnce(snapshot({ restoring: true, hobs: hobsWith({ [QUILL]: { work: true } }) }), yours)).toBe(
        true,
      );
    });

    it("goes to the next request once the one in front is removed or dropped (#1549)", () => {
      const removed = request("a", QUILL, { state: "dropped", droppedBy: OWNER });
      const next = request("b", PIP, { queuedAt: 2 });
      expect(decideFloor(snapshot({ requests: [removed, next] })).action).toEqual(start(next));
    });

    it("starts no request without a backpack and nothing at all with none owed (#1549)", () => {
      const asked = request("a", PIP);
      const s = snapshot({ backpack: false, requests: [asked], hobs: hobsWith({ [PIP]: { work: true } }) });
      expect(decideFloor(s).action).toEqual(start(asked));
      expect(decideFloor({ ...s, requests: [] }).action).toEqual(IDLE);
    });
  });
});
