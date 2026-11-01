import { MenuShortcut } from "@hobbots/ui/components/menu";
import { Toast, ToastAction, ToastDescription, ToastViewport } from "@hobbots/ui/components/toast";
import type { Notice } from "./archive-context.tsx";
import { isMac } from "./archive-rules.ts";
import { messages as copy } from "./messages.ts";

type Archived = Extract<Notice, { kind: "archived" }>;
type Failed = Extract<Notice, { kind: "failed" }>;

/** Where archive toasts show: above the composer. */
export function ArchiveToastViewport() {
  return <ToastViewport label={copy.notifications} className="mx-4 mb-2" />;
}

/** The toast for one notice: Undo after an archive, the reason for a refusal, Try again after a failure. */
export function ArchiveToast({
  notice,
  onClose,
  onUndo,
  onShowRequest,
  onRetry,
}: {
  notice: Notice;
  onClose: () => void;
  onUndo: (archived: Archived) => void;
  onShowRequest: () => void;
  onRetry: (failed: Failed) => void;
}) {
  const close = (open: boolean) => {
    if (!open) onClose();
  };
  const name = notice.hob.name;
  switch (notice.kind) {
    case "archived":
      return (
        <Toast onOpenChange={close}>
          <ToastDescription>{copy.archived({ title: notice.thread.title })}</ToastDescription>
          <MenuShortcut aria-hidden>{copy.undoShortcut({ mac: isMac() })}</MenuShortcut>
          <ToastAction
            altText={copy.undoAlt({ title: notice.thread.title })}
            aria-label={copy.undoAlt({ title: notice.thread.title })}
            onClick={() => onUndo(notice)}
          >
            {copy.undo}
          </ToastAction>
        </Toast>
      );
    case "cant-yet":
      return (
        <Toast tone="refusal" onOpenChange={close}>
          <ToastDescription>{copy.cantYet[notice.block]({ name })}</ToastDescription>
          {notice.block === "approval-pending" && (
            <ToastAction altText={copy.showRequestAlt} onClick={onShowRequest}>
              {copy.showRequest}
            </ToastAction>
          )}
        </Toast>
      );
    case "refused":
      return (
        <Toast tone="refusal" onOpenChange={close}>
          <ToastDescription>{copy.refused[notice.reason]({ name, title: notice.thread.title })}</ToastDescription>
        </Toast>
      );
    case "failed": {
      const title = notice.thread.title;
      return (
        <Toast tone="failure" onOpenChange={close}>
          <ToastDescription>
            {notice.action === "undo" ? copy.undoFailed({ title }) : copy.archiveFailed({ title })}
          </ToastDescription>
          <ToastAction
            altText={copy.tryAgainAlt({ title })}
            aria-label={copy.tryAgainAlt({ title })}
            onClick={() => onRetry(notice)}
          >
            {copy.tryAgain}
          </ToastAction>
        </Toast>
      );
    }
  }
}
