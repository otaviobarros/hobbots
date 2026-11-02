import { TaskFiles } from "@hobbots/agents";
import { AttemptId, TaskFileId } from "@hobbots/domain";
import { Effect, Option, Result } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { DeviceGate } from "./devices.ts";

/** Where one of an Attempt's files is served: `?download=1` serves it as a download. */
export const TASK_FILE_PATH = "/api/attempts/:attemptId/files/:fileId";

const answer = (status: number, text: string) =>
  HttpServerResponse.text(text, { status, headers: { "Cache-Control": "no-store" } });

/** `filename*` per RFC 6266, so any name survives; the plain one keeps only safe characters. */
const disposition = (name: string) =>
  `attachment; filename="${name.replace(/[^\w.-]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(name)}`;

/**
 * `GET /api/attempts/:attemptId/files/:fileId`: one file a Task made or touched, as it is now in the
 * hob's folders (ADR 023). Only an approved device reads it. A preview is served with the media type
 * of the kinds the Files tab previews (images, PDF and text, which is redacted) and nothing else; a
 * download is always `application/octet-stream`, so no file a hob wrote ever runs as a page on the
 * hub's origin.
 */
export const TaskFileRoute = HttpRouter.add(
  "GET",
  TASK_FILE_PATH,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    // The same device check as every API route, before anything is read (ADR 021).
    const admitted = yield* Effect.result((yield* DeviceGate).admit(request));
    if (Result.isFailure(admitted)) {
      const error = admitted.failure;
      return HttpServerResponse.jsonUnsafe(
        { _tag: error._tag, message: error.message },
        { status: error._tag === "ForeignOrigin" ? 403 : 401 },
      );
    }
    const files = yield* Effect.serviceOption(TaskFiles);
    if (Option.isNone(files)) return answer(404, "Not Found");
    const params = yield* HttpRouter.params;
    const download = new URL(request.url, "http://localhost").searchParams.get("download") === "1";
    const served = yield* Effect.result(
      files.value.serve(
        AttemptId.make(params.attemptId ?? ""),
        TaskFileId.make(params.fileId ?? ""),
        download ? "download" : "preview",
      ),
    );
    if (Result.isFailure(served)) return answer(404, "This file is not one the hub can serve.");
    const { file, bytes, mediaType } = served.success;
    const name = file.path.slice(file.path.lastIndexOf("/") + 1);
    return HttpServerResponse.uint8Array(bytes, {
      contentType: mediaType,
      headers: {
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "Cross-Origin-Resource-Policy": "same-origin",
        "Referrer-Policy": "no-referrer",
        "Content-Disposition": download ? disposition(name) : "inline",
      },
    });
  }),
);
