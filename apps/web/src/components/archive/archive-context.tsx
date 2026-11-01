import type { Agent, AgentId, Thread, ThreadId } from "@hobbots/domain";
import { ToastProvider } from "@hobbots/ui/components/toast";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { createContext, type ReactNode, useContext, useEffect, useEffectEvent, useRef, useState } from "react";
import { useArchiveThread, useUndoArchive } from "../../api/archive.ts";
import { ApiError } from "../../api/client.ts";
import { queryKeys } from "../../api/queries.ts";
import { type ArchiveBlock, isArchiveKey, isTextField, isUndoKey, nextThread } from "./archive-rules.ts";
import { ArchiveToast } from "./archive-toast.tsx";
import { useArchiveBlock } from "./use-archive-block.ts";

/** Why the hub refused an archive. */
export type ArchiveRefusal = ArchiveBlock | "hob-retired";

/**
 * Where the workspace shows: a hob's thread, or its fresh page. Archiving the open thread moves to
 * the next one, and the archived thread opens again (after a failure, or on Undo) only while the
 * user is still there.
 */
export interface Place {
  readonly hobId: AgentId;
  readonly threadId: ThreadId | undefined;
}

/** What the toast above the composer says; `id` makes each notice a new toast. */
export type Notice = { readonly id: number; readonly hob: Agent } & (
  | { readonly kind: "archived"; readonly thread: Thread; readonly movedTo: Place | null }
  | { readonly kind: "cant-yet"; readonly block: ArchiveBlock }
  | { readonly kind: "refused"; readonly thread: Thread; readonly reason: ArchiveRefusal }
  | {
      readonly kind: "failed";
      readonly action: "archive" | "undo";
      readonly thread: Thread;
      readonly movedTo: Place | null;
    }
);

type NoticeBody = Notice extends infer N ? (N extends Notice ? Omit<N, "id"> : never) : never;

interface ArchiveActions {
  /** Archives a thread; the open one gives way to the next thread first. */
  readonly archive: (hob: Agent, thread: Thread) => void;
}

const ArchiveContext = createContext<ArchiveActions | null>(null);

/** The archive actions of the chat workspace. */
export const useArchive = (): ArchiveActions => {
  const actions = useContext(ArchiveContext);
  if (actions === null) throw new Error("useArchive needs an ArchiveProvider");
  return actions;
};

const refusalOf = (error: unknown): ArchiveRefusal | undefined =>
  error instanceof ApiError && error.tag === "ThreadArchiveRefused"
    ? (error.fields.reason as ArchiveRefusal | undefined)
    : undefined;

/** Scrolls the open thread's waiting approval card into view and focuses its first button. */
const showRequest = () => {
  const card = document.querySelector<HTMLElement>('main[aria-label="Chat"] section[data-state="pending"]');
  if (card === null) return;
  card.scrollIntoView({ block: "center" });
  card.querySelector<HTMLElement>("button")?.focus();
};

/**
 * Archiving for the chat workspace: the actions behind the thread menus, ⌃⌘A for the open thread,
 * and the toast with Undo, which ⌘Z also takes while it shows and focus is not in a text field.
 */
export function ArchiveProvider({
  hobId,
  threadId,
  children,
}: {
  hobId: AgentId;
  threadId: ThreadId | undefined;
  children: ReactNode;
}) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const archiving = useArchiveThread();
  const undoing = useUndoArchive();
  const [notice, setNotice] = useState<Notice | null>(null);
  const block = useArchiveBlock(threadId);
  // Where the user is now, for callbacks that answer after they may have moved on.
  const here = useRef<Place>({ hobId, threadId });
  useEffect(() => {
    here.current = { hobId, threadId };
  }, [hobId, threadId]);
  const stillAt = (place: Place | null): place is Place =>
    place !== null && here.current.hobId === place.hobId && here.current.threadId === place.threadId;

  const show = (body: NoticeBody) => setNotice((old) => ({ ...body, id: (old?.id ?? 0) + 1 }) as Notice);
  const openThread = (thread: Thread) =>
    void navigate({ to: "/hobs/$hobId/threads/$threadId", params: { hobId: thread.agentId, threadId: thread.id } });

  /** Moves off the open thread to the next one, else the fresh page, and says where. */
  const moveOn = (hob: Agent, thread: Thread): Place => {
    const next = nextThread(
      queryClient.getQueryData<ReadonlyArray<Thread>>(queryKeys.threads(hob.id)) ?? [],
      thread.id,
    );
    if (next) openThread(next);
    else void navigate({ to: "/hobs/$hobId/new", params: { hobId: hob.id } });
    here.current = { hobId: hob.id, threadId: next?.id };
    return here.current;
  };

  const archive = (hob: Agent, thread: Thread) => {
    const movedTo = thread.id === threadId ? moveOn(hob, thread) : null;
    archiving.mutate(thread, {
      onSuccess: () => show({ kind: "archived", hob, thread, movedTo }),
      onError: (error) => {
        // The thread stepped back into the list; it opens again unless the user has moved on.
        if (stillAt(movedTo)) openThread(thread);
        const reason = refusalOf(error);
        show(
          reason
            ? { kind: "refused", hob, thread, reason }
            : { kind: "failed", action: "archive", hob, thread, movedTo },
        );
      },
    });
  };

  const undo = (hob: Agent, thread: Thread, movedTo: Place | null) => {
    setNotice(null);
    undoing.mutate(thread, {
      onSuccess: () => {
        if (stillAt(movedTo)) openThread(thread);
      },
      onError: () => show({ kind: "failed", action: "undo", hob, thread, movedTo }),
    });
  };

  const onKey = useEffectEvent((event: KeyboardEvent) => {
    if (isUndoKey(event) && notice?.kind === "archived" && !isTextField(document.activeElement)) {
      event.preventDefault();
      undo(notice.hob, notice.thread, notice.movedTo);
      return;
    }
    if (!isArchiveKey(event) || threadId === undefined) return;
    const hob = queryClient.getQueryData<ReadonlyArray<Agent>>(queryKeys.agents)?.find((a) => a.id === hobId);
    const thread = queryClient
      .getQueryData<ReadonlyArray<Thread>>(queryKeys.threads(hobId))
      ?.find((t) => t.id === threadId);
    if (hob === undefined || thread === undefined) return;
    event.preventDefault();
    if (block !== null) show({ kind: "cant-yet", hob, block });
    else archive(hob, thread);
  });
  useEffect(() => {
    const listener = (event: KeyboardEvent) => onKey(event);
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, []);

  const retry = (failed: Extract<Notice, { kind: "failed" }>) => {
    setNotice(null);
    if (failed.action === "undo") undo(failed.hob, failed.thread, failed.movedTo);
    else archive(failed.hob, failed.thread);
  };

  return (
    <ArchiveContext.Provider value={{ archive }}>
      <ToastProvider>
        {children}
        {notice && (
          <ArchiveToast
            key={notice.id}
            notice={notice}
            onClose={() => setNotice(null)}
            onUndo={(archived) => undo(archived.hob, archived.thread, archived.movedTo)}
            onShowRequest={showRequest}
            onRetry={retry}
          />
        )}
      </ToastProvider>
    </ArchiveContext.Provider>
  );
}
