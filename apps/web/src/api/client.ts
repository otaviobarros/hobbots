import { HobbotsApi } from "@hobbots/api";
import { Cause, Effect, Exit } from "effect";
import { FetchHttpClient } from "effect/http";
import { HttpApiClient } from "effect/http-api";

/** What macOS reports for the desktop app's login item; `unavailable` outside the installed Mac app. */
export type LoginItemStatus = "enabled" | "requires-approval" | "not-registered" | "not-found" | "unavailable";

export interface LoginItemState {
  readonly openAtLogin: boolean;
  readonly status: LoginItemStatus;
}

declare global {
  interface Window {
    /** Set by the Electron preload script. */
    readonly hobbots?: {
      readonly apiUrl: string;
      readonly loginItem?: {
        readonly get: () => Promise<LoginItemState>;
        readonly set: (openAtLogin: boolean) => Promise<LoginItemState>;
        readonly openSystemSettings: () => Promise<LoginItemState>;
      };
      /** Whether closing the last window keeps Hobbots running in the menu bar. */
      readonly keepRunning?: {
        readonly get: () => Promise<boolean>;
        readonly set: (on: boolean) => Promise<boolean>;
      };
    };
  }
}

// A build served by the Hobbots server calls the API on its own origin; the Vite dev server runs
// apart from the API.
export const API_URL: string =
  globalThis.window?.hobbots?.apiUrl ??
  import.meta.env.VITE_HOBBOTS_API_URL ??
  (import.meta.env.DEV ? "http://127.0.0.1:4317" : globalThis.location.origin);

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
