import { AgentId, BackpackItem, BackpackItemId, BackpackItemState, QuestId } from "@hobbots/domain";
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api";
import { AgentNotFound, HobUnavailable, QuestNotFound } from "./errors.ts";
import { UserSessionOnly } from "./user-session.ts";

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
  .prefix("/api") {}

export class BackpackItemNotFound extends Schema.TaggedError<BackpackItemNotFound>()(
  "BackpackItemNotFound",
  { itemId: BackpackItemId },
  { httpApiStatus: 404 },
) {}

/** The item has no blocker waiting for a choice: it is not failed, or another choice was made first. */
export class BlockerClosed extends Schema.TaggedError<BlockerClosed>()(
  "BlockerClosed",
  { itemId: BackpackItemId, state: BackpackItemState },
  { httpApiStatus: 409 },
) {}

/** Retry puts the item back to pending with a fresh set of deliveries; Dismiss resolves it as dismissed by you. */
export const DecideBlockerPayload = Schema.Struct({ action: Schema.Literals(["retry", "dismiss"]) });
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
  .middleware(UserSessionOnly)
  .prefix("/api") {}
