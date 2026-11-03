import { ExportScope } from "@hobbots/domain";
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api";
import { AgentNotFound, InvalidFolder, ThreadNotFound } from "./errors.ts";
import { DeviceSession } from "./user-session.ts";

export const ExportPayload = Schema.Struct({
  scope: ExportScope,
  /** The folder on the hub the export goes in: a full path, or one that starts with `~/`. */
  destination: Schema.String.check(Schema.isMaxLength(4096)),
});
export type ExportPayload = typeof ExportPayload.Type;

/** A finished export: its folder on the hub, and how much it holds. */
export const ExportResult = Schema.Struct({
  folder: Schema.String,
  threads: Schema.Int,
  quests: Schema.Int,
  /** File artifacts copied into `files/`. */
  files: Schema.Int,
  /** File artifacts listed with why they were not copied. */
  notCopied: Schema.Int,
});
export type ExportResult = typeof ExportResult.Type;

/** Where Hobbots offers to save an export: the hub user's Downloads folder, or their home folder without one. */
export const ExportDestination = Schema.Struct({ folder: Schema.String });
export type ExportDestination = typeof ExportDestination.Type;

/** The export could not be written; what it had written is deleted. */
export class ExportFailed extends Schema.TaggedError<ExportFailed>()(
  "ExportFailed",
  { message: Schema.String },
  { httpApiStatus: 500 },
) {}

/**
 * Exports of ADR 026. A destination is refused as an `InvalidFolder` when it is not a folder on
 * the hub, or when it is inside a folder hobs work in.
 */
export class ExportsGroup extends HttpApiGroup.make("exports")
  .add(
    HttpApiEndpoint.get("destination", "/exports/destination", { success: ExportDestination }),
    HttpApiEndpoint.post("create", "/exports", {
      payload: ExportPayload,
      success: ExportResult,
      error: [InvalidFolder, AgentNotFound, ThreadNotFound, ExportFailed],
    }),
  )
  .middleware(DeviceSession)
  .prefix("/api") {}
