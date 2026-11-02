import { HobbotsApi } from "@hobbots/api";
import { Cause, Effect, Exit } from "effect";
import { FetchHttpClient, HttpClient } from "effect/http";
import { HttpApiClient } from "effect/http-api";

/** What macOS reports for the desktop app's login item; `unavailable` outside the installed Mac app. */
type LoginItemStatus = "enabled" | "requires-approval" | "not-registered" | "not-found" | "unavailable";

export interface LoginItemState {
  readonly openAtLogin: boolean;
  readonly status: LoginItemStatus;
}

declare global {
  interface Window {
    /** Set by the Electron preload script. */
    readonly hobbots?: {
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
      /** Opens the system folder picker; resolves with the chosen folder, or null when cancelled. */
      readonly chooseFolder?: () => Promise<string | null>;
      /**
       * Calls `listener` with each request the desktop app asks to show in the Inbox, as when its
       * notification is clicked; answers a function that stops listening.
       */
      readonly onOpenRequest?: (listener: (requestId: string) => void) => () => void;
    };
  }
}

// Every client calls the API on its own origin (ADR 021): the hub serves the built client, and in
// development the Vite dev server forwards `/api` to the hub. The device cookie and the origin
// rules are then the same everywhere. Outside a page, as in unit tests, URLs stay relative.
export const API_URL: string = globalThis.location?.origin ?? "";

type Client = HttpApiClient.ForApi<typeof HobbotsApi>;

// The web client exports no traces, so requests go without trace headers.
const clientPromise: Promise<Client> = Effect.runPromise(
  HttpApiClient.make(HobbotsApi, {
    baseUrl: API_URL,
    transformClient: HttpClient.transform((request) =>
      Effect.provideService(request, HttpClient.TracerPropagationEnabled, false),
    ),
  }).pipe(Effect.provide(FetchHttpClient.layer)),
);

export class ApiError extends Error {
  constructor(
    message: string,
    readonly tag: string | undefined,
    /** The tagged error's own fields, such as a refusal's `reason`. */
    readonly fields: Readonly<Record<string, unknown>> = {},
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
  // Tagged API errors carry their fields but no message, so the tag stands in for an empty one.
  const message = error instanceof Error && error.message !== "" ? error.message : (tag ?? "Request failed");
  const fields = typeof error === "object" && error !== null ? { ...error } : {};
  throw new ApiError(message, tag, fields);
};

/** Where the hub serves the whole output of a tool step that shows only its start and end. */
export const toolLogUrl = (threadId: string, messageId: string, stepId: string): string =>
  `${API_URL}/api/threads/${encodeURIComponent(threadId)}/messages/${encodeURIComponent(messageId)}/steps/${encodeURIComponent(stepId)}/log`;
