import {
  MemoryChange,
  MemoryForgetDay,
  MemoryHit,
  MemoryPage,
  MemoryPageSummary,
  MemoryPageVersion,
  MemoryPath,
  MemoryScope,
  MemoryScopeKey,
  MemoryVersion,
  MemoryVersionChanges,
} from "@hobbots/domain";
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api";
import { DeviceSession } from "./user-session.ts";

/**
 * Memory, as the Memory page reads and changes it (ADR 028). Every call goes through the hub, which
 * reaches memory as you: the page never reaches the engine itself. Each change is a new version of
 * the page, written by you, that History lists and can restore.
 */

/** Memory did not answer. The page keeps what it last loaded under a notice. */
export class MemoryNotAnswering extends Schema.TaggedError<MemoryNotAnswering>()(
  "MemoryNotAnswering",
  {},
  { httpApiStatus: 503 },
) {}

/** There is no such page, or no such version of it. */
export class MemoryPageNotFound extends Schema.TaggedError<MemoryPageNotFound>()(
  "MemoryPageNotFound",
  { path: MemoryPath },
  { httpApiStatus: 404 },
) {}

/**
 * The page changed since you read it, as when a hob saved it while you were editing: nothing was
 * written. `current` is its version now, or null when it is gone.
 */
export class MemoryPageChanged extends Schema.TaggedError<MemoryPageChanged>()(
  "MemoryPageChanged",
  { path: MemoryPath, current: Schema.NullOr(MemoryVersion) },
  { httpApiStatus: 409 },
) {}

/** A scope and how many pages it holds. */
export const MemoryScopeCount = Schema.Struct({ scope: MemoryScope, pages: Schema.Number });
export type MemoryScopeCount = typeof MemoryScopeCount.Type;

/** What the Memory page opens with: every scope that holds a page, with its count. */
export const MemoryScopes = Schema.Struct({ scopes: Schema.Array(MemoryScopeCount) });
export type MemoryScopes = typeof MemoryScopes.Type;

/** A page as it is now, and every version of it, newest first. */
export const MemoryPageRead = Schema.Struct({ page: MemoryPage, history: Schema.Array(MemoryPageVersion) });
export type MemoryPageRead = typeof MemoryPageRead.Type;

const pageQuery = { scope: MemoryScopeKey, path: MemoryPath };

/** The most characters a page you write may hold. */
export const MEMORY_PAGE_MAX = 65_536;

/**
 * A page as you save it: its whole markdown, tags, pin and forget day, and the version you last
 * read, or null for a new page. It is written only while that is still the latest.
 */
export const MemoryPageSave = Schema.Struct({
  ...pageQuery,
  markdown: Schema.String.check(Schema.isMaxLength(MEMORY_PAGE_MAX)),
  tags: Schema.Array(Schema.String.check(Schema.isMaxLength(64))).check(Schema.isMaxLength(32)),
  pinned: Schema.Boolean,
  forgetOn: Schema.NullOr(MemoryForgetDay),
  expected: Schema.NullOr(MemoryVersion),
});
export type MemoryPageSave = typeof MemoryPageSave.Type;

/** A version of a page: the one you read, for a delete, or the one to bring back, for a restore. */
export const MemoryPageVersionRef = Schema.Struct({ ...pageQuery, version: MemoryVersion });
export type MemoryPageVersionRef = typeof MemoryPageVersionRef.Type;

/** What a delete answers: the version a restore brings the page back from, for Undo. */
export const MemoryPageDeleted = Schema.Struct({ restoreFrom: Schema.NullOr(MemoryVersion) });
export type MemoryPageDeleted = typeof MemoryPageDeleted.Type;

export class MemoryPagesGroup extends HttpApiGroup.make("memoryPages")
  .add(
    HttpApiEndpoint.get("scopes", "/memory/scopes", {
      success: MemoryScopes,
      error: MemoryNotAnswering,
    }),
  )
  .add(
    // What memory saved lately, newest first. The hub looks about once a minute and streams what
    // it finds as `MemoryChanged`.
    HttpApiEndpoint.get("changes", "/memory/changes", {
      success: Schema.Array(MemoryChange),
      error: MemoryNotAnswering,
    }),
  )
  .add(
    // A scope's pages: pinned first, then the most recently changed.
    HttpApiEndpoint.get("pages", "/memory/pages", {
      query: { scope: MemoryScopeKey },
      success: Schema.Array(MemoryPageSummary),
      error: MemoryNotAnswering,
    }),
  )
  .add(
    HttpApiEndpoint.get("page", "/memory/page", {
      query: pageQuery,
      success: MemoryPageRead,
      error: [MemoryNotAnswering, MemoryPageNotFound],
    }),
  )
  .add(
    // What one version of a page changed against the version it replaced.
    HttpApiEndpoint.get("version", "/memory/version", {
      query: { ...pageQuery, version: MemoryVersion },
      success: MemoryVersionChanges,
      error: [MemoryNotAnswering, MemoryPageNotFound],
    }),
  )
  .add(
    // Pages that mention every word of `q`, in one scope or, without `scope`, in all of them.
    HttpApiEndpoint.get("search", "/memory/search", {
      query: {
        q: Schema.String.check(Schema.isMaxLength(200)),
        scope: Schema.optionalKey(MemoryScopeKey),
      },
      success: Schema.Array(MemoryHit),
      error: MemoryNotAnswering,
    }),
  )
  .add(
    // Writes the page as a new version by you: an edit, a pin, a forget day, or a new page.
    HttpApiEndpoint.post("save", "/memory/page", {
      payload: MemoryPageSave,
      success: MemoryPageRead,
      error: [MemoryNotAnswering, MemoryPageChanged],
    }),
  )
  .add(
    // Deletes the page and its history, while `version` is still the latest.
    HttpApiEndpoint.post("delete", "/memory/page/delete", {
      payload: MemoryPageVersionRef,
      success: MemoryPageDeleted,
      error: [MemoryNotAnswering, MemoryPageChanged],
    }),
  )
  .add(
    // Writes `version`, from History or from a delete, back as a new version by you.
    HttpApiEndpoint.post("restore", "/memory/page/restore", {
      payload: MemoryPageVersionRef,
      success: MemoryPageRead,
      error: [MemoryNotAnswering, MemoryPageChanged],
    }),
  )
  .middleware(DeviceSession)
  .prefix("/api") {}
