import { HobbotsApi } from "@hobbots/api";
import { Cause, Effect, Exit } from "effect";
import { FetchHttpClient } from "effect/http";
import { HttpApiClient } from "effect/http-api";

declare global {
  interface Window {
    /** Set by the Electron preload script. */
    readonly hobbots?: { readonly apiUrl: string };
  }
}

export const API_URL: string =
  globalThis.window?.hobbots?.apiUrl ?? import.meta.env.VITE_HOBBOTS_API_URL ?? "http://127.0.0.1:4317";

type Client = HttpApiClient.ForApi<typeof HobbotsApi>;

const clientPromise: Promise<Client> = Effect.runPromise(
  HttpApiClient.make(HobbotsApi, { baseUrl: API_URL }).pipe(Effect.provide(FetchHttpClient.layer)),
);

export class ApiError extends Error {
  constructor(
    message: string,
    readonly tag: string | undefined,
  ) {
    super(message);
  }
}

/** Runs a typed API call and resolves with its value, or rejects with an ApiError. */
export const call = async <A, E>(f: (client: Client) => Effect.Effect<A, E>): Promise<A> => {
  const exit = await Effect.runPromiseExit(f(await clientPromise));
  if (Exit.isSuccess(exit)) return exit.value;
  const error = Cause.squash(exit.cause);
  const tag = typeof error === "object" && error !== null && "_tag" in error ? String(error._tag) : undefined;
  throw new ApiError(error instanceof Error ? error.message : (tag ?? "Request failed"), tag);
};
