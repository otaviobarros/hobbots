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
}

const every = (tick: () => void, ms: number) => {
  const timer = setInterval(tick, ms);
  return () => clearInterval(timer);
};

/**
 * Notifies the user of new requests from the main process, so it works with no window open: in the
 * menu bar after the last window closed, or after opening at login. `start` it once the hub runs.
 */
export const requestNotices = ({ read, isFocused, notify, open }: RequestNoticesOptions) => {
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

  let checking = false;
  const check = async () => {
    // A read still under way finishes first, so a slow hub never announces a request twice.
    if (checking) return;
    checking = true;
    try {
      await reconcile();
    } finally {
      checking = false;
    }
  };

  const reconcile = async () => {
    const pending = pendingRequests(await read("/api/approvals"));
    // An unanswered read changes nothing: what is shown stays until the hub says otherwise.
    if (pending === null) return;
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
   * Reads at once, to learn what already waits, then every `everyMs`, so a request that arrives
   * before the first tick is announced rather than taken for one that was already there. Answers a
   * function that stops it.
   */
  const start = (everyMs: number, schedule: (tick: () => void, ms: number) => () => void = every) => {
    const first = check();
    const stop = schedule(() => void check(), everyMs);
    return { first, stop };
  };

  return { check, start };
};
