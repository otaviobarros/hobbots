import { Schema } from "effect";
import { RuntimeKind } from "./agent.ts";
import { AgentId } from "./ids.ts";
import { defineMachine } from "./machine.ts";

/**
 * How many turns run at once (#1448, OR-005): limits on the active turns of each hob, each Quest and
 * each runtime, kept by the hub across restarts. A turn past a limit waits, as a queued message, a
 * pending backpack item or a queued step, and starts once a slot frees, Quests taking turns so a
 * busy one never starves another. The limits count turns, not usage: a runtime reports what a turn
 * used only as it ends, so no limit here can promise a usage budget.
 */

/** How many turns one scope may run at once: from 1 to 64. */
const TurnLimit = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(64));

/** The limits on active turns. Every runtime has its own, since each runs its turns apart. */
export const TurnLimits = Schema.Struct({
  /** Turns one hob runs at once, across its chats, steps and Tasks. */
  perHob: TurnLimit,
  /** Turns one Quest's work runs at once: its lead's and every member's, steps included. */
  perQuest: TurnLimit,
  /** Turns each runtime runs at once, across every hob. */
  perRuntime: Schema.Struct({ "claude-code": TurnLimit, codex: TurnLimit }),
});
export type TurnLimits = typeof TurnLimits.Type;

export const DEFAULT_TURN_LIMITS: TurnLimits = {
  perHob: 4,
  perQuest: 6,
  perRuntime: { "claude-code": 8, codex: 8 },
};

/**
 * Why a turn waits: its hob, its Quest or its runtime runs as many turns as its limit allows, or
 * (`fair-order`) it would fit, but a turn of a Quest that had fewer turns lately waits for the slot.
 */
export const TurnWait = Schema.Literals(["hob", "quest", "runtime", "fair-order"]);
export type TurnWait = typeof TurnWait.Type;

/** What a turn counts against: its hob, its runtime and, for work on a Task, the Quest it is in. */
export interface TurnHolder {
  readonly agentId: AgentId;
  readonly runtime: RuntimeKind;
  /** The top Task of the work's tree, which every Quest in it shares; null outside any Task. */
  readonly quest: string | null;
}

export const TurnTicketState = Schema.Literals(["waiting", "active", "released", "withdrawn"]);
export type TurnTicketState = typeof TurnTicketState.Type;

/** One turn's place: waiting for a slot, holding one, or done with it. */
export interface TurnTicket extends TurnHolder {
  /** What the turn starts for: a chat (`thread:`), a step (`step:`) or a member's Task (`member:`). */
  readonly id: string;
  /** Only `TurnTicketMachine` changes it. */
  readonly state: TurnTicketState;
  /** Why it waits, while it waits; null otherwise. */
  readonly waitingOn: TurnWait | null;
  /** When it first asked, counted by the hub, so turns of one Quest start in the order they asked. */
  readonly asked: number;
}

export type TurnTicketEvent =
  /** The turn still cannot start, for this reason. */
  | { readonly _tag: "Wait"; readonly reason: TurnWait }
  /** A slot is its: the turn starts. */
  | { readonly _tag: "Admit" }
  /** The turn ended, and its slot frees. */
  | { readonly _tag: "Release" }
  /** What waited no longer needs a turn, as when it started with another one or went away. */
  | { readonly _tag: "Withdraw" };

/** A change to a turn's ticket its state does not allow. */
export class IllegalTurnTicketTransition extends Schema.TaggedError<IllegalTurnTicketTransition>()(
  "IllegalTurnTicketTransition",
  { id: Schema.String, from: TurnTicketState, to: TurnTicketState },
) {}

export const TurnTicketMachine = defineMachine<
  TurnTicketState,
  TurnTicketEvent,
  TurnTicket,
  IllegalTurnTicketTransition
>({
  name: "TurnTicket",
  states: {
    waiting: "Past a limit, or behind another Quest's turn; what it starts for stays queued",
    active: "Holds a slot: the turn runs",
    released: "The turn ended and its slot is free",
    withdrawn: "It stopped waiting without a turn",
  },
  field: "state",
  events: {
    Wait: { from: ["waiting"], to: "waiting", apply: (ticket, event) => ({ ...ticket, waitingOn: event.reason }) },
    Admit: { from: ["waiting"], to: "active", apply: (ticket) => ({ ...ticket, state: "active", waitingOn: null }) },
    Release: { from: ["active"], to: "released", apply: (ticket) => ({ ...ticket, state: "released" }) },
    Withdraw: {
      from: ["waiting"],
      to: "withdrawn",
      apply: (ticket) => ({ ...ticket, state: "withdrawn", waitingOn: null }),
    },
  },
  illegal: (ticket, _event, to) => new IllegalTurnTicketTransition({ id: ticket.id, from: ticket.state, to }),
});

/** Which limit `holder` would go past if it started now beside `active`, or null when it fits. */
export const limitReached = (
  limits: TurnLimits,
  active: ReadonlyArray<TurnHolder>,
  holder: TurnHolder,
): TurnWait | null => {
  if (active.filter((each) => each.agentId === holder.agentId).length >= limits.perHob) return "hob";
  if (holder.quest !== null && active.filter((each) => each.quest === holder.quest).length >= limits.perQuest) {
    return "quest";
  }
  if (active.filter((each) => each.runtime === holder.runtime).length >= limits.perRuntime[holder.runtime]) {
    return "runtime";
  }
  return null;
};

/** The group a turn takes turns in: its Quest, or the turn alone outside any. */
const groupOf = (ticket: TurnTicket) => (ticket.quest === null ? `turn:${ticket.id}` : `quest:${ticket.quest}`);

/**
 * The waiting turns in the order slots go to them: first the group that started a turn least
 * recently (`served` holds when each last did, a higher number later; one that never did comes
 * first), then within it the turn that asked first.
 */
export const fairOrder = (
  waiting: ReadonlyArray<TurnTicket>,
  served: ReadonlyMap<string, number>,
): ReadonlyArray<TurnTicket> => {
  const lastServed = (ticket: TurnTicket) => served.get(groupOf(ticket)) ?? -1;
  return [...waiting].sort((a, b) => lastServed(a) - lastServed(b) || a.asked - b.asked);
};

/** The group of a turn, as `served` keys it: what the hub records when the turn starts. */
export const turnGroup = groupOf;

/**
 * Which waiting turns start now, in order: each in turn takes a slot if it fits beside those that
 * run and those taken before it, so a turn yields a slot only to one that comes first and fits. The
 * others wait, with why: a limit they reached, or `fair-order` when only turns ahead of them stand
 * in the way.
 */
export const admitInOrder = (
  limits: TurnLimits,
  active: ReadonlyArray<TurnHolder>,
  waiting: ReadonlyArray<TurnTicket>,
  served: ReadonlyMap<string, number>,
): ReadonlyArray<{ readonly ticket: TurnTicket; readonly wait: TurnWait | null }> => {
  const taken: Array<TurnHolder> = [...active];
  return fairOrder(waiting, served).map((ticket) => {
    const reached = limitReached(limits, taken, ticket);
    if (reached === null) {
      taken.push(ticket);
      return { ticket, wait: null };
    }
    return { ticket, wait: limitReached(limits, active, ticket) ?? "fair-order" };
  });
};

/** A turn that holds a slot, as the hub reports it. */
export const ActiveTurn = Schema.Struct({
  id: Schema.String,
  agentId: AgentId,
  runtime: RuntimeKind,
  quest: Schema.NullOr(Schema.String),
});
export type ActiveTurn = typeof ActiveTurn.Type;

/** A turn that waits for a slot, and why. */
export const WaitingTurn = Schema.Struct({
  id: Schema.String,
  agentId: AgentId,
  runtime: RuntimeKind,
  quest: Schema.NullOr(Schema.String),
  waitingOn: TurnWait,
});
export type WaitingTurn = typeof WaitingTurn.Type;

/**
 * The hub's turns now: the limits, the turns that run and those that wait. `usage` says when the
 * runtimes report what a turn used: at its end, so a limit on turns is no limit on usage.
 */
export const TurnSlotsReport = Schema.Struct({
  limits: TurnLimits,
  active: Schema.Array(ActiveTurn),
  waiting: Schema.Array(WaitingTurn),
  usage: Schema.Literal("after-turn"),
});
export type TurnSlotsReport = typeof TurnSlotsReport.Type;
