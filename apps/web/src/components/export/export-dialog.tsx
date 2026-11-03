import type { Agent, Thread } from "@hobbots/domain";
import { Button } from "@hobbots/ui/components/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@hobbots/ui/components/dialog";
import { ExportForm } from "./export-form.tsx";
import { messages as copy } from "./messages.ts";

/** What a menu exports: the thread it was opened on, or the hob. */
export type ExportTarget = { readonly thread: Thread } | { readonly hob: Agent };

const textOf = (target: ExportTarget) =>
  "thread" in target
    ? { title: copy.dialogTitle.thread({ title: target.thread.title }), intro: copy.dialogIntro.thread }
    : {
        title: copy.dialogTitle.hob({ name: target.hob.name }),
        intro: copy.dialogIntro.hob({ name: target.hob.name }),
      };

/** Export from a thread's or a hob's menu: the same form as Settings › Export, for that one thread or hob. */
export function ExportDialog({ target, onClose }: { target: ExportTarget; onClose: () => void }) {
  const { title, intro } = textOf(target);
  const scope =
    "thread" in target
      ? ({ _tag: "Thread", threadId: target.thread.id } as const)
      : ({ _tag: "Hob", agentId: target.hob.id } as const);
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogTitle className="m-0 font-pixel text-2xl font-bold break-words text-moonlight">{title}</DialogTitle>
        <DialogDescription className="m-0 text-sm text-secondary-text">
          {intro} {copy.redacted}
        </DialogDescription>
        <ExportForm scope={scope} />
        <div className="flex justify-end">
          <Button variant="outline" onClick={onClose}>
            {copy.close}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
