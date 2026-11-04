import type { Agent, AgentId, Thread } from "@hobbots/domain";
import { Toast, ToastAction, ToastDescription, ToastProvider, ToastViewport } from "@hobbots/ui/components/toast";
import { createContext, type ReactNode, useContext, useState } from "react";
import { useArchiveThread } from "../../api/archive.ts";
import { useRestoreThread } from "../../api/archived-threads.ts";
import { useBringBackHob, useRetireAgain } from "../../api/queries.ts";
import { messages } from "./messages.ts";

const copy = messages.toast;

/** What the Archive's toast says; `id` makes each notice a new toast. */
type Notice = { readonly id: number; readonly hob: Agent } & (
  | { readonly kind: "restored"; readonly thread: Thread }
  | { readonly kind: "failed"; readonly action: "restore" | "undo"; readonly thread: Thread }
  | { readonly kind: "back"; readonly chats: number }
  | { readonly kind: "hob-failed"; readonly action: "bring-back" | "undo"; readonly chats: number }
);

type NoticeBody = Notice extends infer N ? (N extends Notice ? Omit<N, "id"> : never) : never;

interface ArchiveActions {
  /** Restores an archived chat, then says so with Undo. `onDone` runs once it is restored. */
  readonly restore: (hob: Agent, thread: Thread, onDone?: () => void) => void;
  /** Whether this chat is being restored or archived again right now. */
  readonly busy: (thread: Thread) => boolean;
  /**
   * Brings a retired hob back, then says how many chats came with it, with Undo. `onDone` runs once
   * it is back.
   */
  readonly bringBack: (hob: Agent, chats: number, onDone?: () => void) => void;
  /** Whether this hob is being brought back or retired again right now. */
  readonly hobBusy: (hobId: AgentId) => boolean;
}

const ArchiveActionsContext = createContext<ArchiveActions | null>(null);

export const useArchiveActions = (): ArchiveActions => {
  const actions = useContext(ArchiveActionsContext);
  if (actions === null) throw new Error("useArchiveActions needs an ArchiveNotices");
  return actions;
};

/**
 * The Archive's actions and their toast, shared by its pages so a toast stays when an action moves
 * back to the list. Undo archives a restored chat again, or retires a hob brought back.
 */
export function ArchiveNotices({ children }: { children: ReactNode }) {
  const restoring = useRestoreThread();
  const archiving = useArchiveThread();
  const bringing = useBringBackHob();
  const retiring = useRetireAgain();
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

  const archiveAgain = (hob: Agent, thread: Thread) => {
    setNotice(null);
    archiving.mutate(thread, { onError: () => show({ kind: "failed", action: "undo", hob, thread }) });
  };

  const bringBack = (hob: Agent, chats: number, onDone?: () => void) => {
    setNotice(null);
    bringing.mutate(hob.id, {
      onSuccess: (back) => {
        onDone?.();
        show({ kind: "back", hob: back, chats });
      },
      onError: () => show({ kind: "hob-failed", action: "bring-back", hob, chats }),
    });
  };

  const retireAgain = (hob: Agent, chats: number) => {
    setNotice(null);
    retiring.mutate(hob.id, { onError: () => show({ kind: "hob-failed", action: "undo", hob, chats }) });
  };

  const busy = (thread: Thread) =>
    (restoring.isPending && restoring.variables === thread.id) ||
    (archiving.isPending && archiving.variables?.id === thread.id);
  const hobBusy = (hobId: AgentId) =>
    (bringing.isPending && bringing.variables === hobId) || (retiring.isPending && retiring.variables === hobId);

  const undo = (current: Notice) => {
    if (current.kind === "restored") archiveAgain(current.hob, current.thread);
    if (current.kind === "back") retireAgain(current.hob, current.chats);
  };
  const retry = (current: Notice) => {
    if (current.kind === "failed") {
      if (current.action === "undo") archiveAgain(current.hob, current.thread);
      else restore(current.hob, current.thread);
    }
    if (current.kind === "hob-failed") {
      if (current.action === "undo") retireAgain(current.hob, current.chats);
      else bringBack(current.hob, current.chats);
    }
  };

  return (
    <ArchiveActionsContext.Provider value={{ restore, busy, bringBack, hobBusy }}>
      <ToastProvider>
        {children}
        {notice && (
          <NoticeToast
            key={notice.id}
            notice={notice}
            onClose={() => setNotice(null)}
            onUndo={() => undo(notice)}
            onRetry={() => retry(notice)}
          />
        )}
        <ToastViewport
          label={copy.region}
          // standards-allow STD-I18N-004: left-1/2 with -translate-x-1/2 centers the box, and translate has no logical form
          className="fixed bottom-4 left-1/2 z-50 w-[min(520px,calc(100%-32px))] -translate-x-1/2"
        />
      </ToastProvider>
    </ArchiveActionsContext.Provider>
  );
}

/** What the toast says, and what its one action is called: Undo after a change, Try again after a failure. */
const toastText = (notice: Notice): { line: string; action: string; alt: string; failed: boolean } => {
  const name = notice.hob.name;
  switch (notice.kind) {
    case "restored": {
      const title = notice.thread.title;
      return { line: copy.restored({ title, name }), action: copy.undo, alt: copy.undoAlt({ title }), failed: false };
    }
    case "failed": {
      const title = notice.thread.title;
      const line = notice.action === "undo" ? copy.undoFailed({ title }) : copy.restoreFailed({ title });
      return { line, action: copy.tryAgain, alt: copy.tryAgainAlt({ title }), failed: true };
    }
    case "back":
      return {
        line: copy.back({ name, chats: notice.chats }),
        action: copy.undo,
        alt: copy.undoBackAlt({ name }),
        failed: false,
      };
    case "hob-failed": {
      const line = notice.action === "undo" ? copy.retireFailed({ name }) : copy.backFailed({ name });
      return { line, action: copy.tryAgain, alt: copy.tryAgainAlt({ title: name }), failed: true };
    }
  }
};

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
  const text = toastText(notice);
  return (
    <Toast tone={text.failed ? "failure" : "default"} onOpenChange={close}>
      <ToastDescription>{text.line}</ToastDescription>
      <ToastAction altText={text.alt} aria-label={text.alt} onClick={text.failed ? onRetry : onUndo}>
        {text.action}
      </ToastAction>
    </Toast>
  );
}
