import type { Agent, Thread } from "@hobbots/domain";
import { Toast, ToastAction, ToastDescription, ToastProvider, ToastViewport } from "@hobbots/ui/components/toast";
import { createContext, type ReactNode, useContext, useState } from "react";
import { useArchiveThread } from "../../api/archive.ts";
import { useRestoreThread } from "../../api/archived-threads.ts";
import { messages } from "./messages.ts";

const copy = messages.toast;

/** What the Archive's toast says; `id` makes each notice a new toast. */
type Notice = { readonly id: number; readonly hob: Agent; readonly thread: Thread } & (
  | { readonly kind: "restored" }
  | { readonly kind: "failed"; readonly action: "restore" | "undo" }
);

type NoticeBody = Notice extends infer N ? (N extends Notice ? Omit<N, "id"> : never) : never;

interface ArchiveActions {
  /** Restores an archived chat, then says so with Undo. `onDone` runs once it is restored. */
  readonly restore: (hob: Agent, thread: Thread, onDone?: () => void) => void;
  /** Whether this chat is being restored or archived again right now. */
  readonly busy: (thread: Thread) => boolean;
}

const ArchiveActionsContext = createContext<ArchiveActions | null>(null);

export const useArchiveActions = (): ArchiveActions => {
  const actions = useContext(ArchiveActionsContext);
  if (actions === null) throw new Error("useArchiveActions needs an ArchiveNotices");
  return actions;
};

/**
 * The Archive's actions and their toast, shared by its pages so a toast stays when Restore moves
 * from a chat back to the list. Undo archives the chat again.
 */
export function ArchiveNotices({ children }: { children: ReactNode }) {
  const restoring = useRestoreThread();
  const archiving = useArchiveThread();
  const [notice, setNotice] = useState<Notice | null>(null);
  const show = (body: NoticeBody) => setNotice((old) => ({ ...body, id: (old?.id ?? 0) + 1 }) as Notice);

  const restore = (hob: Agent, thread: Thread, onDone?: () => void) => {
    setNotice(null);
    restoring.mutate(thread.id, {
      onSuccess: () => {
        onDone?.();
        show({ kind: "restored", hob, thread });
      },
      onError: () => show({ kind: "failed", action: "restore", hob, thread }),
    });
  };

  const undo = (hob: Agent, thread: Thread) => {
    setNotice(null);
    archiving.mutate(thread, { onError: () => show({ kind: "failed", action: "undo", hob, thread }) });
  };

  const busy = (thread: Thread) =>
    (restoring.isPending && restoring.variables === thread.id) ||
    (archiving.isPending && archiving.variables?.id === thread.id);

  return (
    <ArchiveActionsContext.Provider value={{ restore, busy }}>
      <ToastProvider>
        {children}
        {notice && (
          <NoticeToast
            key={notice.id}
            notice={notice}
            onClose={() => setNotice(null)}
            onUndo={() => undo(notice.hob, notice.thread)}
            onRetry={() =>
              notice.kind === "failed" && notice.action === "undo"
                ? undo(notice.hob, notice.thread)
                : restore(notice.hob, notice.thread)
            }
          />
        )}
        <ToastViewport
          label={copy.region}
          className="fixed bottom-4 left-1/2 z-50 w-[min(520px,calc(100%-32px))] -translate-x-1/2"
        />
      </ToastProvider>
    </ArchiveActionsContext.Provider>
  );
}

function NoticeToast({
  notice,
  onClose,
  onUndo,
  onRetry,
}: {
  notice: Notice;
  onClose: () => void;
  onUndo: () => void;
  onRetry: () => void;
}) {
  const close = (open: boolean) => {
    if (!open) onClose();
  };
  const title = notice.thread.title;
  if (notice.kind === "restored") {
    return (
      <Toast onOpenChange={close}>
        <ToastDescription>{copy.restored({ title, name: notice.hob.name })}</ToastDescription>
        <ToastAction altText={copy.undoAlt({ title })} aria-label={copy.undoAlt({ title })} onClick={onUndo}>
          {copy.undo}
        </ToastAction>
      </Toast>
    );
  }
  return (
    <Toast tone="failure" onOpenChange={close}>
      <ToastDescription>
        {notice.action === "undo" ? copy.undoFailed({ title }) : copy.restoreFailed({ title })}
      </ToastDescription>
      <ToastAction altText={copy.tryAgainAlt({ title })} aria-label={copy.tryAgainAlt({ title })} onClick={onRetry}>
        {copy.tryAgain}
      </ToastAction>
    </Toast>
  );
}
