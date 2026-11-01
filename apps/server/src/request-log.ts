import { Effect } from "effect";
import { HttpMiddleware, HttpRouter, HttpServerRequest } from "effect/http";

/**
 * True for a read that succeeded: a GET or HEAD answered below 400. Clients make these all the time,
 * such as the web client's queries and the desktop app reading the Inbox when it changes, so they
 * are not worth a log line.
 */
export const isRoutineRead = (method: string, status: number) =>
  (method === "GET" || method === "HEAD") && status < 400;

/**
 * Leaves routine reads out of the request log. Writes and failures are still logged, with their
 * method, URL and status, so the log shows what changed and what went wrong.
 */
export const QuietRoutineReads = HttpRouter.middleware(
  (effect) =>
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const response = yield* effect;
      if (isRoutineRead(request.method, response.status)) yield* HttpMiddleware.withLoggerDisabled(Effect.void);
      return response;
    }),
  { global: true },
);
