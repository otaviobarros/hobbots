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

/** Which system notifications the desktop app sends, each on until turned off. */
export interface NotificationChoices {
  readonly requests: boolean;
  readonly devices: boolean;
  readonly sound: boolean;
}

/** What the user can do about the connection to the hub on a connected desktop (ADR 025). */
export type ConnectionAction = "tryAgain" | "openTailscale" | "changeAddress" | "askAgain" | "disconnect";

/**
 * A connected desktop's view of its hub: names, address, versions and state. The app writes `title`
 * and `detail` itself, since it knows its own states and this computer's language, and a hub's pages
 * may be from another version that does not know a newer state.
 */
export interface ConnectionView {
  readonly hubName: string;
  readonly nodeName: string;
  readonly address: string;
  readonly appVersion: string;
  readonly hubVersion: string | null;
  readonly state: string;
  /** Absent from an app from before the reasons (ADR 025): a page then shows its own generic text. */
  readonly title?: string;
  readonly detail?: string;
  readonly actions?: ReadonlyArray<ConnectionAction>;
}

/** The answer to a typed address: taken, or why not in the user's words. */
export type AddressChangeAnswer = { readonly ok: true } | { readonly ok: false; readonly message: string };

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
      /** Which system notifications the desktop app sends; `set` changes the ones it names. */
      readonly notifications?: {
        readonly get: () => Promise<NotificationChoices>;
        readonly set: (patch: Partial<NotificationChoices>) => Promise<NotificationChoices>;
      };
      /** Opens the system folder picker; resolves with the chosen folder, or null when cancelled. */
      readonly chooseFolder?: () => Promise<string | null>;
      /**
       * Shows one of an Attempt's files in Finder, selected. The desktop app asks the hub which
       * file the id names, so the page never hands it a path; resolves false when the hub does not
       * list it or it is gone.
       */
      readonly showFile?: (attemptId: string, fileId: string) => Promise<boolean>;
      /**
       * Calls `listener` with each request the desktop app asks to show in the Inbox, as when its
       * notification is clicked; answers a function that stops listening.
       */
      readonly onOpenRequest?: (listener: (requestId: string) => void) => () => void;
      /**
       * Only on a connected desktop (ADR 025): the hub it uses and where the connection stands. A
       * page checks each call before it uses it, since the app may be of another version.
       */
      readonly connection?: {
        readonly get: () => Promise<ConnectionView>;
        readonly retry?: () => Promise<ConnectionView>;
        readonly changeAddress?: (address: string) => Promise<AddressChangeAnswer>;
        readonly openTailscale?: () => Promise<boolean>;
        readonly onChange?: (listener: (view: ConnectionView) => void) => () => void;
      };
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

/** Where the hub serves a command's whole output, which its record in the Terminal shows cut (ADR 023). */
export const commandLogUrl = (attemptId: string, commandId: string): string =>
  `${API_URL}/api/attempts/${encodeURIComponent(attemptId)}/commands/${encodeURIComponent(commandId)}/log`;
