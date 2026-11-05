import {
  MemoryChange,
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
 * Memory, as the Memory page reads it (ADR 028). Every read goes through the hub, which reads
 * memory as you: the page never reaches the engine itself.
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
  .middleware(DeviceSession)
  .prefix("/api") {}
