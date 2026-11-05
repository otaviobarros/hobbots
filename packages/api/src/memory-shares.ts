import { MEMORY_PAGE_MAX, MemoryFinding, MemoryShare, MemoryShareState } from "@hobbots/domain";
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api";
import { MemoryNotAnswering } from "./memory-pages.ts";
import { DeviceSession } from "./user-session.ts";

/**
 * What hobs ask to share, and Check now (ADR 028, Sharing). A share waits for you in the Inbox and
 * in Memory › To review under Careful and Balanced, and always for About you; you share it, edit it
 * then share it, keep it private, or take a share back. Only a user session decides (PE-006).
 */

/** There is no such share. */
export class MemoryShareNotFound extends Schema.TaggedError<MemoryShareNotFound>()(
  "MemoryShareNotFound",
  { shareId: Schema.String },
  { httpApiStatus: 404 },
) {}

/** The share is no longer where the decision needs it: decided already, or not shared. */
export class MemoryShareClosed extends Schema.TaggedError<MemoryShareClosed>()(
  "MemoryShareClosed",
  { shareId: Schema.String, state: MemoryShareState },
  { httpApiStatus: 409 },
) {}

/** The page changed in its shared memory since the share read it, so nothing was written over it. */
export class MemoryShareChangedMeanwhile extends Schema.TaggedError<MemoryShareChangedMeanwhile>()(
  "MemoryShareChangedMeanwhile",
  { shareId: Schema.String },
  { httpApiStatus: 409 },
) {}

/** The shares that wait for you, then the latest you or the preset decided, newest first. */
export const MemorySharesList = Schema.Struct({ shares: Schema.Array(MemoryShare) });
export type MemorySharesList = typeof MemorySharesList.Type;

/** Sharing a page: as the hob wrote it, or as you edited it. */
export const ShareMemoryPayload = Schema.Struct({
  markdown: Schema.optionalKey(Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(MEMORY_PAGE_MAX))),
});
export type ShareMemoryPayload = typeof ShareMemoryPayload.Type;

/** What the last Check now found, and when it ran; null `checkedAt` before the first one. */
export const MemoryCheck = Schema.Struct({
  checkedAt: Schema.NullOr(Schema.String),
  findings: Schema.Array(MemoryFinding),
});
export type MemoryCheck = typeof MemoryCheck.Type;

const shareParams = { shareId: Schema.String };
const decisionErrors = [MemoryShareNotFound, MemoryShareClosed, MemoryShareChangedMeanwhile, MemoryNotAnswering];

export class MemorySharesGroup extends HttpApiGroup.make("memoryShares")
  .add(HttpApiEndpoint.get("list", "/memory/shares", { success: MemorySharesList }))
  .add(
    HttpApiEndpoint.post("share", "/memory/shares/:shareId/share", {
      params: shareParams,
      payload: ShareMemoryPayload,
      success: MemoryShare,
      error: decisionErrors,
    }),
  )
  .add(
    // Keeps the page private: it goes to the hob's own memory instead.
    HttpApiEndpoint.post("keep", "/memory/shares/:shareId/keep", {
      params: shareParams,
      success: MemoryShare,
      error: decisionErrors,
    }),
  )
  .add(
    // Takes a share back: the shared page is as it was before, and the hob keeps the page itself.
    HttpApiEndpoint.post("undo", "/memory/shares/:shareId/undo", {
      params: shareParams,
      success: MemoryShare,
      error: decisionErrors,
    }),
  )
  .add(HttpApiEndpoint.get("lastCheck", "/memory/check", { success: MemoryCheck }))
  .add(
    // Checks every scope for pages that disagree or look out of date, changing nothing.
    HttpApiEndpoint.post("check", "/memory/check", { success: MemoryCheck, error: MemoryNotAnswering }),
  )
  .middleware(DeviceSession)
  .prefix("/api") {}
