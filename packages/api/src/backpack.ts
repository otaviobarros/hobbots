import { AgentId, BackpackItem, QuestId } from "@hobbots/domain";
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api";
import { AgentNotFound, QuestNotFound } from "./errors.ts";

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
