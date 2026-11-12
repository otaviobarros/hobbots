import type { AgentId, ClaimClash, Message, MessageId, ThreadId } from "@hobbots/domain";
import { taskTitle } from "../quest/work-model.ts";

/** One side of a clash, as its Heads-up names it. */
interface HeadsUpSide {
  readonly key: string;
  readonly ownerId: AgentId;
  readonly task: string;
  /** The claim on what: a path or branch name. */
  readonly on: string;
  /** Whether its Task's work belongs to another chat or camp than the one showing it. */
  readonly elsewhere: boolean;
}

/** A clash between Tasks' claims as a chat or camp shows it (ADR 037): what is claimed, by whom, and who claimed it last. */
export interface HeadsUp {
  readonly key: string;
  readonly at: string;
  readonly scope: "path" | "branch";
  readonly sides: ReadonlyArray<HeadsUpSide>;
  /** The claim that made it a clash: the newest. */
  readonly spotted: HeadsUpSide;
}

/** The Heads-up for an open clash, from the claims register, as `threadId` shows it. */
export const headsUpOf = (clash: ClaimClash, threadId: ThreadId): HeadsUp | null => {
  const sides = clash.sides.map(
    (side): HeadsUpSide => ({
      key: side.claim.id,
      ownerId: side.ownerId,
      task: taskTitle({ brief: side.brief }),
      on: side.claim.key,
      elsewhere: side.threadId !== threadId,
    }),
  );
  const newest = clash.sides.reduce<(typeof clash.sides)[number] | undefined>(
    (latest, side) => (latest === undefined || side.claim.createdAt > latest.claim.createdAt ? side : latest),
    undefined,
  );
  const spotted = sides.find((side) => side.key === newest?.claim.id);
  if (spotted === undefined || sides.length < 2) return null;
  return {
    key: sides.map((side) => side.key).join("+"),
    at: clash.since,
    scope: newest?.claim.scope === "branch" ? "branch" : "path",
    sides,
    spotted,
  };
};

/** Where Heads-ups before the first message go. */
export const BEFORE_FIRST = "before-first";

/** Places each Heads-up after the last message written before its clash began, as work moments are placed. */
export const placeHeadsUps = (
  transcript: ReadonlyArray<Message>,
  headsUps: ReadonlyArray<HeadsUp>,
): ReadonlyMap<MessageId | typeof BEFORE_FIRST, ReadonlyArray<HeadsUp>> => {
  const placed = new Map<MessageId | typeof BEFORE_FIRST, Array<HeadsUp>>();
  for (const headsUp of headsUps) {
    const key = transcript.findLast((message) => message.createdAt <= headsUp.at)?.id ?? BEFORE_FIRST;
    placed.set(key, [...(placed.get(key) ?? []), headsUp]);
  }
  return placed;
};
