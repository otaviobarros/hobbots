import { AttemptActivity, AttemptFiles, AttemptId, CommandId, ContentId, TaskId, TreeActivity } from "@hobbots/domain";
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/http-api";
import { TaskNotFound } from "./errors.ts";
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

/**
 * The records of every Attempt under a Task, with the event stream cursor taken just before the read
 * (#899). Following `GET /api/tasks/:taskId/workbench/events` from `cursor` brings each change to it
 * since: the records the tree's Attempts make, new Tasks and Attempts, reassignments and completions,
 * and the output of every command running in the tree.
 */
export const TreeActivityRead = Schema.Struct({ cursor: Schema.String, activity: TreeActivity });
export type TreeActivityRead = typeof TreeActivityRead.Type;

/** What an Attempt ran, changed and made, as the Workbench reads it (ADR 023). Reads only. */
export class WorkbenchGroup extends HttpApiGroup.make("workbench")
  .add(
    // One read for a Quest's whole Workbench: every Attempt under the Task, nested Quests included.
    HttpApiEndpoint.get("tree", "/tasks/:taskId/workbench", {
      params: { taskId: TaskId },
      success: TreeActivityRead,
      error: TaskNotFound,
    }),
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
    // The files the Attempt made or touched, as they are now in the hob's folders. One is served
    // for a preview or a download at `/api/attempts/:attemptId/files/:fileId`, outside this group,
    // since each kind of file goes with its own media type.
    HttpApiEndpoint.get("files", "/attempts/:attemptId/files", {
      params: { attemptId: AttemptId },
      success: AttemptFiles,
      error: AttemptNotFound,
    }),
  )
  .middleware(DeviceSession)
  .prefix("/api") {}
