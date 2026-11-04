import { coalesce } from "./coalesce.ts";
import { type ReadUntilOptions, readUntil } from "./read-until.ts";
import {
  deviceNoticeText,
  devicePairings,
  type FinishedQuest,
  failedNoticeText,
  failedTasks,
  finishedNoticeText,
  type NoticeState,
  noticeChanges,
  noticeText,
  pendingRequests,
  questionNoticeText,
  type TaskLink,
  waitingQuestions,
} from "./request-notices-model.ts";

/** A notification the system shows; `close` takes it away. */
interface ShownNotice {
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
  /**
   * Opens or reveals the window at a Task in its lead's chat, so the room opens with that lane lit
   * (ADR 027), or only brings the window forward for work with no thread.
   */
  readonly openTask?: (link: TaskLink | null) => void;
  /** How an Inbox read that did not answer is made again. */
  readonly retry?: ReadUntilOptions;
}

/** Where one kind of waiting item is read, and how its notification reads. */
interface NoticeSource<P extends { readonly id: string }> {
  readonly path: string;
  /** The waiting items in the hub's answer, or null when it is not one. */
  readonly pending: (body: unknown) => ReadonlyArray<P> | null;
  /** The notifications for new items, in their order. */
  readonly texts: (items: ReadonlyArray<P>) => Promise<ReadonlyArray<{ title: string; body: string }>>;
  /** When an item runs out on its own, with no event to say so: the list is read again then. */
  readonly expiresAt?: (item: P) => string;
  /** What clicking an item's notification opens, instead of the item in the Inbox. */
  readonly open?: (item: P) => void;
}

/** How long until a moment after the first item runs out, or undefined when none does. */
const untilFirstExpiry = <P>(items: ReadonlyArray<P>, expiresAt: ((item: P) => string) | undefined) => {
  if (expiresAt === undefined || items.length === 0) return undefined;
  const first = Math.min(...items.map((item) => Date.parse(expiresAt(item))));
  return Math.max(1000, first - Date.now() + 500);
};

/**
 * Notifies the user of new items of one kind from the main process, comparing each read with what
 * is shown: a new item is announced while no window is focused, and an item that no longer waits,
 * wherever it was decided, closes its notification.
 */
const makeNotices = <P extends { readonly id: string }>(
  { read, isFocused, notify, open, retry }: RequestNoticesOptions,
  source: NoticeSource<P>,
) => {
  let state: NoticeState = { known: undefined, shown: new Set() };
  const shown = new Map<string, ShownNotice>();
  let expiry: ReturnType<typeof setTimeout> | undefined;

  const reconcile = async () => {
    // A read that did not answer is made again until one does, since no later event may come. Until
    // then what is shown stays.
    const pending = await readUntil(async () => source.pending(await read(source.path)), retry);
    const changes = noticeChanges(state, pending, isFocused());
    for (const id of changes.close) {
      shown.get(id)?.close();
      shown.delete(id);
    }
    if (changes.show.length > 0) {
      const texts = await source.texts(changes.show);
      changes.show.forEach((item, index) => {
        const text = texts[index];
        if (text === undefined) return;
        const notice = notify(text, () => {
          shown.delete(item.id);
          if (source.open) source.open(item);
          else open(item.id);
        });
        shown.set(item.id, notice);
      });
    }
    state = { known: changes.known, shown: new Set(shown.keys()) };
    // An item that runs out sends no event, so its notification closes when the list is read then.
    clearTimeout(expiry);
    const wait = untilFirstExpiry(pending, source.expiresAt);
    if (wait !== undefined) expiry = setTimeout(() => void check(), wait);
  };

  /**
   * Compares the hub's list with what is shown. The first check learns what already waits. A check
   * asked for while one is under way runs once more after it, so a slow hub never announces an item
   * twice and a change that arrived meanwhile is never missed.
   */
  const check = coalesce(reconcile);

  return { check };
};

/**
 * Notifies the user of new requests from the main process, so it works with no window open: in the
 * menu bar after the last window closed, or after opening at login. `check` it whenever the hub's
 * event stream connects and whenever a request arrives or is decided.
 */
/** Every hob's name by its id, or none when the hub did not answer. */
const hobNames = async (read: RequestNoticesOptions["read"]): Promise<ReadonlyMap<string, string>> => {
  const hobs = await read("/api/agents");
  if (!Array.isArray(hobs)) return new Map();
  return new Map(
    hobs.flatMap((hob: { id?: unknown; name?: unknown }) =>
      typeof hob?.id === "string" && typeof hob.name === "string" ? [[hob.id, hob.name] as const] : [],
    ),
  );
};

export const requestNotices = (options: RequestNoticesOptions) =>
  makeNotices(options, {
    path: "/api/approvals",
    pending: pendingRequests,
    texts: async (requests) => {
      const names = await hobNames(options.read);
      return requests.map((request) => noticeText(request, names.get(request.agentId)));
    },
  });

/**
 * Notifies the user of each question that climbed every lead and reached them (ADR 027), as
 * `requestNotices` does for requests: one answered anywhere closes. Clicking it opens the room at
 * the asking hob's lane. `check` it whenever the event stream connects and whenever a question changes.
 */
export const questionNotices = (options: RequestNoticesOptions) =>
  makeNotices(options, {
    path: "/api/questions",
    pending: waitingQuestions,
    texts: async (questions) => {
      const names = await hobNames(options.read);
      return questions.map((question) => questionNoticeText(question, names.get(question.askerId)));
    },
    open: (question) => options.openTask?.(question.link),
  });

/**
 * Notifies the user of each party member's Task that failed while its work goes on (ADR 027): one
 * retried or reassigned anywhere, or whose work ended, closes. `check` it whenever the event stream
 * connects and whenever a Task changes.
 */
export const failedTaskNotices = (options: RequestNoticesOptions) =>
  makeNotices(options, {
    path: "/api/failed-tasks",
    pending: failedTasks,
    texts: async (tasks) => {
      const names = await hobNames(options.read);
      return tasks.map((task) => failedNoticeText(task, names.get(task.ownerId)));
    },
    open: (task) => options.openTask?.(task.link),
  });

/**
 * Notifies the user that a top Quest finished, from its journal entry, while no window is focused
 * (ADR 027). A Quest is announced once, however often its entry is replayed.
 */
export const finishedNotices = (options: RequestNoticesOptions) => {
  const announced = new Set<string>();
  const finished = async (quest: FinishedQuest) => {
    if (announced.has(quest.id) || options.isFocused()) return;
    announced.add(quest.id);
    const names = await hobNames(options.read);
    options.notify(finishedNoticeText(quest, names.get(quest.leadId)), () => options.openTask?.(quest.link));
  };
  return { finished };
};

/**
 * Notifies the user of each new device asking to pair (ADR 021), as `requestNotices` does for
 * requests. `check` it whenever the event stream connects and whenever a pairing request changes.
 */
export const deviceNotices = (options: RequestNoticesOptions) =>
  makeNotices(options, {
    path: "/api/pairing/requests",
    pending: devicePairings,
    texts: async (devices) => devices.map(deviceNoticeText),
    expiresAt: (device) => device.expiresAt,
  });
