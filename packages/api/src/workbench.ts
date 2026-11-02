import { AttemptActivity, AttemptId, CommandId, ContentId } from "@hobbots/domain";
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/http-api";
import { DeviceSession } from "./user-session.ts";

/** No Attempt has the id. */
export class AttemptNotFound extends Schema.TaggedError<AttemptNotFound>()(
  "AttemptNotFound",
  { attemptId: AttemptId },
  { httpApiStatus: 404 },
) {}

/**
 * The detail is not one the Attempt's records name, or it is no longer kept: cleared past the
 * retention window, or never kept. The record itself says which.
 */
export class ActivityDetailNotFound extends Schema.TaggedError<ActivityDetailNotFound>()(
  "ActivityDetailNotFound",
  { attemptId: AttemptId },
  { httpApiStatus: 404 },
) {}

/**
 * An Attempt's records, with the event stream cursor taken just before the read (ADR 013).
 * Following the stream from `cursor` brings each command, file change and scan recorded since, and
 * a running command's output as it comes.
 */
export const AttemptActivityRead = Schema.Struct({ cursor: Schema.String, activity: AttemptActivity });
export type AttemptActivityRead = typeof AttemptActivityRead.Type;

/** What an Attempt ran, changed and made, as the Workbench reads it (ADR 023). Reads only. */
export class WorkbenchGroup extends HttpApiGroup.make("workbench")
  .add(
    HttpApiEndpoint.get("activity", "/attempts/:attemptId/activity", {
      params: { attemptId: AttemptId },
      success: AttemptActivityRead,
      error: AttemptNotFound,
    }),
    // A command's whole redacted output, which its record shows cut.
    HttpApiEndpoint.get("commandLog", "/attempts/:attemptId/commands/:commandId/log", {
      params: { attemptId: AttemptId, commandId: CommandId },
      success: Schema.String.pipe(HttpApiSchema.asText({ contentType: "text/plain; charset=utf-8" })),
      error: ActivityDetailNotFound,
    }),
    // Kept contents a file change of the Attempt names: text redacted, images as they were.
    HttpApiEndpoint.get("content", "/attempts/:attemptId/contents/:contentId", {
      params: { attemptId: AttemptId, contentId: ContentId },
      success: Schema.Uint8Array.pipe(HttpApiSchema.asUint8Array({ contentType: "application/octet-stream" })),
      error: ActivityDetailNotFound,
    }),
  )
  .middleware(DeviceSession)
  .prefix("/api") {}
