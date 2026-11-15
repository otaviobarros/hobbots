import { Schema } from "effect";
import { AgentId } from "./ids.ts";

/**
 * How many turns run at once (#1590, OR-005): at most `MAX_ACTIVE_TURNS` across the hub. A turn past
 * the cap waits, as a queued message, a pending backpack item or a queued step, and starts once a
 * slot frees, in the order the turns asked. The cap counts turns, not usage: a runtime reports what
 * a turn used only as it ends, so no cap here can promise a usage budget.
 */
export const MAX_ACTIVE_TURNS = 4;

/** A turn that holds a slot, or waits for one: what it starts for and its hob. */
export const SlotTurn = Schema.Struct({
  /** What the turn starts for: a chat (`thread:`), a step (`step:`) or a member's Task (`member:`). */
  id: Schema.String,
  agentId: AgentId,
});
export type SlotTurn = typeof SlotTurn.Type;

/**
 * The hub's turns now: the cap, the turns that run and those that wait, in the order they start.
 * `usage` says when the runtimes report what a turn used: at its end, so a cap on turns is no cap
 * on usage.
 */
export const TurnSlotsReport = Schema.Struct({
  cap: Schema.Int,
  active: Schema.Array(SlotTurn),
  waiting: Schema.Array(SlotTurn),
  usage: Schema.Literal("after-turn"),
});
export type TurnSlotsReport = typeof TurnSlotsReport.Type;
