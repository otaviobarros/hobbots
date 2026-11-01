/**
 * Which system notifications the desktop app shows for requests waiting in the Inbox. Electron's
 * main process reads the hub's Inbox whenever the event stream says it changed, so this works with
 * no window open, and every read is compared with what is shown: a request decided anywhere,
 * missed events included, closes.
 */
import { exactAction } from "@hobbots/domain";
import { messages } from "./messages.ts";

const copy = messages.requestNotice;

/** A request waiting for the user, as the notification needs it. */
export interface PendingRequest {
  readonly id: string;
  readonly agentId: string;
  /** The exact action: the command, address or path the call was made with, or the step's words. */
  readonly action: string;
}

/** The pending requests in the hub's Inbox answer, or null when it is not one. */
export const pendingRequests = (body: unknown): ReadonlyArray<PendingRequest> | null => {
  if (!Array.isArray(body)) return null;
  return body.flatMap((item: unknown) => {
    if (typeof item !== "object" || item === null) return [];
    const approval = item as Record<string, unknown>;
    if (approval.state !== "pending" || typeof approval.id !== "string" || typeof approval.agentId !== "string") {
      return [];
    }
    const args = typeof approval.arguments === "object" && approval.arguments !== null ? approval.arguments : {};
    const label = typeof approval.label === "string" ? approval.label : "";
    return [
      {
        id: approval.id,
        agentId: approval.agentId,
        action: exactAction({ arguments: args as Record<string, unknown>, label }),
      },
    ];
  });
};

export interface NoticeState {
  /** Requests already seen waiting; undefined until the first read, which announces nothing. */
  readonly known: ReadonlySet<string> | undefined;
  /** Requests with a notification showing. */
  readonly shown: ReadonlySet<string>;
}

/**
 * What one read of the Inbox changes: new requests to `show` while no Hobbots window is focused,
 * and notifications to `close` because their request no longer waits. The first read only learns
 * what already waits, so opening the app announces nothing, and a request that arrives while the
 * window is focused is never announced later.
 */
export const noticeChanges = (
  state: NoticeState,
  pending: ReadonlyArray<PendingRequest>,
  focused: boolean,
): {
  readonly show: ReadonlyArray<PendingRequest>;
  readonly close: ReadonlyArray<string>;
  readonly known: ReadonlySet<string>;
} => {
  const waiting = new Set(pending.map((request) => request.id));
  const fresh = state.known === undefined ? [] : pending.filter((request) => !state.known?.has(request.id));
  return {
    show: focused ? [] : fresh,
    close: [...state.shown].filter((id) => !waiting.has(id)),
    // Only what still waits, so the set stays as small as the Inbox.
    known: waiting,
  };
};

/** Electron's notification docs say macOS truncates a notification past 256 bytes. */
const NOTICE_BYTES = 240;

const bytes = (text: string) => new TextEncoder().encode(text).length;

/** The notification for a request: who asks, or "A hob" while that is unknown, and the exact action, cut to fit. */
export const noticeText = (
  request: PendingRequest,
  name: string | undefined,
): { readonly title: string; readonly body: string } => {
  const title = copy.title({ name: name ?? copy.unknownHob });
  const room = NOTICE_BYTES - bytes(title);
  if (bytes(request.action) <= room) return { title, body: request.action };
  let body = "";
  for (const char of request.action) {
    if (bytes(`${body}${char}…`) > room) break;
    body += char;
  }
  return { title, body: `${body}…` };
};
