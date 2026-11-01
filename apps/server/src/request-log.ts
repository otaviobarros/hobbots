import { Effect } from "effect";
import { HttpMiddleware, HttpRouter, HttpServerRequest } from "effect/http";

/**
 * True for a read that succeeded: a GET or HEAD answered below 400. Clients make these all the time,
 * such as the web client's queries and the desktop app reading the Inbox when it changes, so they
 * are logged only at Debug.
 */
export const isRoutineRead = (method: string, status: number) =>
  (method === "GET" || method === "HEAD") && status < 400;

/**
 * Logs routine reads at Debug, below the default `Info`, so they show only when `HOBBOTS_LOG_LEVEL`
 * asks for them. Writes and failures are still logged at Info with their method, URL and status, so
 * the log shows what changed and what went wrong.
 */
export const QuietRoutineReads = HttpRouter.middleware(
  (effect) =>
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const response = yield* effect;
      if (isRoutineRead(request.method, response.status)) {
        // The router's own request log writes at the current level, so this line replaces it.
        yield* HttpMiddleware.withLoggerDisabled(
          Effect.logDebug("Sent HTTP response").pipe(
            Effect.annotateLogs({
              "http.method": request.method,
              "http.url": request.url.split("?")[0],
              "http.status": response.status,
            }),
          ),
        );
      }
      return response;
    }),
  { global: true },
);
