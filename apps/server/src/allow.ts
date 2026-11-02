import { readFileSync } from "node:fs";
import { NodeRuntime } from "@effect/platform-node";
import { HobbotsApi } from "@hobbots/api";
import { Console, Effect } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import { HttpApiClient } from "effect/http-api";
import { ServerConfig } from "./config.ts";
import { windowKeyFile } from "./window-key.ts";

/**
 * Allows a waiting device from the command line, for a hub with no window, such as during
 * development (ADR 021): `pnpm --filter @hobbots/server allow 482913`. Without a code it lists the
 * devices waiting. It acts as the hub's window, with the window key from the data folder, so it
 * works only on the hub and only for someone who can read that folder.
 */
const allow = Effect.gen(function* () {
  const config = yield* ServerConfig;
  const key = yield* Effect.try(() => readFileSync(windowKeyFile(config.dataDir), "utf8").trim()).pipe(
    Effect.mapError(() => `No window key in ${config.dataDir}: is the hub running with this data folder?`),
  );
  const client = yield* HttpApiClient.make(HobbotsApi, {
    baseUrl: `http://127.0.0.1:${config.port}`,
    transformClient: HttpClient.mapRequest(HttpClientRequest.bearerToken(key)),
  });
  const waiting = yield* client.pairingRequests.list();
  const code = process.argv.slice(2).join("").replaceAll(" ", "");
  if (code === "") {
    if (waiting.length === 0) return yield* Console.log("No device is waiting for approval.");
    for (const request of waiting) {
      yield* Console.log(`${request.code.slice(0, 3)} ${request.code.slice(3)}  ${request.name} (${request.platform})`);
    }
    return;
  }
  const request = waiting.find((candidate) => candidate.code === code);
  if (request === undefined) return yield* Effect.fail(`No device is waiting with the code ${code}.`);
  yield* client.pairingRequests.allow({ params: { requestId: request.id } });
  yield* Console.log(`Allowed ${request.name}.`);
}).pipe(
  Effect.provide(FetchHttpClient.layer),
  Effect.catch((error) =>
    Console.error(typeof error === "string" ? error : String(error)).pipe(
      Effect.andThen(
        Effect.sync(() => {
          process.exitCode = 1;
        }),
      ),
    ),
  ),
);

NodeRuntime.runMain(allow);
