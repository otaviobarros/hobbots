import type { Agent, Channel, Line } from "@hobbots/domain";
import { mainLine } from "@hobbots/domain";
import type { TurnReason } from "./pack-people.ts";

/**
 * Who a turn belongs to (ADR 039, One hob speaks at a time): the hob that holds a line's floor. A
 * camp has one floor and many speakers, so the hob a turn is for is its speaker, never the hob the
 * channel belongs to (`channel.ownerHobId`, STD-ARCH-021). Everything inside a turn reads its hob from
 * here: its prompt and brief, skills, pack, memory and tools.
 */
export interface Speaker {
  /** The channel the turn runs in, as the turn read it when it started. */
  readonly channel: Channel;
  /** The conversation of that channel whose floor the turn holds. */
  readonly line: Line;
  /** The hob that speaks. */
  readonly agent: Agent;
  /**
   * Why it speaks, as the floor's `TurnRequest` records it; null for a turn no request started, such
   * as Continue or backpack work, whose reason is worked out from its prompt.
   */
  readonly reason: TurnReason | null;
  /**
   * Whether the hob is the one the channel belongs to, or a member hob of a camp it joined. A member
   * turn is admitted under the camp's lock, not its own, so its launch reads it again (ADR 039).
   */
  readonly role: "owner" | "member";
}

/** `agent` speaking in `line` of `channel`, its main line until threads come (#1472), for `reason`. */
export const speakerIn = (
  channel: Channel,
  agent: Agent,
  reason: TurnReason | null = null,
  line: Line = mainLine(channel.id),
): Speaker => ({
  channel,
  line,
  agent,
  reason,
  role: agent.id === channel.ownerHobId ? "owner" : "member",
});
