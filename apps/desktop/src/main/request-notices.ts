import { coalesce } from "./coalesce.ts";
import { type ReadUntilOptions, readUntil } from "./read-until.ts";
import { type NoticeState, noticeChanges, noticeText, pendingRequests } from "./request-notices-model.ts";

/** A notification the system shows; `close` takes it away. */
export interface ShownNotice {
  readonly close: () => void;
}

export interface RequestNoticesOptions {
  /** Reads a hub route as the Hobbots app, or answers null when the hub did not answer. */
  readonly read: (path: string) => Promise<unknown>;
  /** Whether a Hobbots window has focus; its Inbox shows new requests already. */
  readonly isFocused: () => boolean;
  /** Shows a system notification; `onClick` runs when the user clicks it. */
  readonly notify: (notice: { title: string; body: string }, onClick: () => void) => ShownNotice;
  /** Opens or reveals the window and shows the request in the Inbox. */
  readonly open: (requestId: string) => void;
  /** How an Inbox read that did not answer is made again. */
  readonly retry?: ReadUntilOptions;
}

/**
 * Notifies the user of new requests from the main process, so it works with no window open: in the
 * menu bar after the last window closed, or after opening at login. `check` it whenever the hub's
 * event stream connects and whenever a request arrives or is decided.
 */
export const requestNotices = ({ read, isFocused, notify, open, retry }: RequestNoticesOptions) => {
  let state: NoticeState = { known: undefined, shown: new Set() };
  const shown = new Map<string, ShownNotice>();

  const hobNames = async (): Promise<ReadonlyMap<string, string>> => {
    const hobs = await read("/api/agents");
    if (!Array.isArray(hobs)) return new Map();
    return new Map(
      hobs.flatMap((hob: { id?: unknown; name?: unknown }) =>
        typeof hob?.id === "string" && typeof hob.name === "string" ? [[hob.id, hob.name] as const] : [],
      ),
    );
  };

  const reconcile = async () => {
    // A read that did not answer is made again until one does, since no later event may come. Until
    // then what is shown stays.
    const pending = await readUntil(async () => pendingRequests(await read("/api/approvals")), undefined, retry);
    const changes = noticeChanges(state, pending, isFocused());
    for (const id of changes.close) {
      shown.get(id)?.close();
      shown.delete(id);
    }
    if (changes.show.length > 0) {
      const names = await hobNames();
      for (const request of changes.show) {
        const notice = notify(noticeText(request, names.get(request.agentId)), () => {
          shown.delete(request.id);
          open(request.id);
        });
        shown.set(request.id, notice);
      }
    }
    state = { known: changes.known, shown: new Set(shown.keys()) };
  };

  /**
   * Compares the Inbox with what is shown. The first check learns what already waits. A check asked
   * for while one is under way runs once more after it, so a slow hub never announces a request
   * twice and a change that arrived meanwhile is never missed.
   */
  const check = coalesce(reconcile);

  return { check };
};
