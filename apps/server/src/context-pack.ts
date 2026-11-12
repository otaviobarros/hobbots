import { ChatService } from "@hobbots/agents";
import { ThreadId } from "@hobbots/domain";
import { Effect, Layer, Result } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/http";
import { forApprovedDevice } from "./devices.ts";

/**
 * `GET /api/dev/threads/:threadId/pack`, in a checkout only (ADR 037, #1380): the context pack the
 * thread's next new session would start from, its text and its `PackReport`, and the report of the
 * pack its last such turn read, if the hub kept one. Only an approved device reads it. It is for
 * review and debugging, so a release build of the hub does not serve it.
 */
const ContextPackRoute = HttpRouter.add(
  "GET",
  "/api/dev/threads/:threadId/pack",
  forApprovedDevice(() =>
    Effect.gen(function* () {
      const params = yield* HttpRouter.params;
      const chat = yield* ChatService;
      const found = yield* Effect.result(chat.contextPack(ThreadId.make(params.threadId ?? "")));
      if (Result.isFailure(found)) {
        return HttpServerResponse.jsonUnsafe({ _tag: "ThreadNotFound" }, { status: 404 });
      }
      return HttpServerResponse.jsonUnsafe(found.success, { headers: { "Cache-Control": "no-store" } });
    }),
  ),
);

/** The route for a hub run from a checkout, whose version is `development`; nothing for a release. */
export const DevRoutes = (version: string) => (version === "development" ? ContextPackRoute : Layer.empty);
