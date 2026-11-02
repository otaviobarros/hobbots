import { AgentId, BackpackItem, BackpackItemId, BackpackItemState, QuestId } from "@hobbots/domain";
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api";
import { AgentNotFound, HobUnavailable, QuestNotFound } from "./errors.ts";
import { DeviceSession } from "./user-session.ts";

/**
 * Backpack items not yet resolved or failed, highest priority first, then oldest first, with the
 * event stream cursor taken just before the read (ADR 013). Each later change to an item arrives
 * on the stream as `BackpackItemRecorded` or `BackpackItemChanged`, with a newer revision.
 */
export const BackpackRead = Schema.Struct({ cursor: Schema.String, items: Schema.Array(BackpackItem) });
export type BackpackRead = typeof BackpackRead.Type;

/** What hobs still have to deal with (ADR 019): reads only. You look into a backpack; you never work it. */
export class BackpackGroup extends HttpApiGroup.make("backpack")
  .add(
    // Every hob's open items, for the workspace's view of what hobs are waiting on.
    HttpApiEndpoint.get("workspace", "/backpack", { success: BackpackRead }),
    HttpApiEndpoint.get("hob", "/agents/:agentId/backpack", {
      params: { agentId: AgentId },
      success: BackpackRead,
      error: AgentNotFound,
    }),
    // The items about a Quest's work, in its lead's and its members' backpacks.
    HttpApiEndpoint.get("quest", "/quests/:questId/backpack", {
      params: { questId: QuestId },
      success: BackpackRead,
      error: QuestNotFound,
    }),
  )
  .middleware(DeviceSession)
  .prefix("/api") {}

export class BackpackItemNotFound extends Schema.TaggedError<BackpackItemNotFound>()(
  "BackpackItemNotFound",
  { itemId: BackpackItemId },
  { httpApiStatus: 404 },
) {}

/**
 * The blocker named takes no choice: another choice was made for it first, or the item failed
 * again since and a newer blocker took its place.
 */
export class BlockerClosed extends Schema.TaggedError<BlockerClosed>()(
  "BlockerClosed",
  { itemId: BackpackItemId, blocker: Schema.Int, state: BackpackItemState },
  { httpApiStatus: 409 },
) {}

/**
 * Your choice for the item's blocker numbered `blocker`, the one you saw. Retry puts the item back
 * to pending with a fresh set of deliveries; Dismiss resolves it as dismissed by you.
 */
export const DecideBlockerPayload = Schema.Struct({
  blocker: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  action: Schema.Literals(["retry", "dismiss"]),
});
export type DecideBlockerPayload = typeof DecideBlockerPayload.Type;

/**
 * Blockers (IN-007): failed backpack items that wait for your choice, shown in your Inbox and on
 * their Task's card. Only a user session reaches it (PE-006).
 */
export class BlockersGroup extends HttpApiGroup.make("blockers")
  .add(
    // Every item whose blocker waits for you, oldest blocker first.
    HttpApiEndpoint.get("list", "/blockers", { success: BackpackRead }),
    // Choosing again what was already chosen returns the item unchanged. Retry is refused while its hob is retired.
    HttpApiEndpoint.post("decide", "/blockers/:itemId/decision", {
      params: { itemId: BackpackItemId },
      payload: DecideBlockerPayload,
      success: BackpackItem,
      error: [BackpackItemNotFound, BlockerClosed, HobUnavailable],
    }),
  )
  .middleware(DeviceSession)
  .prefix("/api") {}
