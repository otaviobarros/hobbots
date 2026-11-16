import type { Agent, Channel } from "@hobbots/domain";
import { Button } from "@hobbots/ui/components/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@hobbots/ui/components/dialog";
import { ExportForm } from "./export-form.tsx";
import { messages as copy } from "./messages.ts";

/** What a menu exports: the channel it was opened on, or the hob. */
export type ExportTarget = { readonly channel: Channel } | { readonly hob: Agent };

const textOf = (target: ExportTarget) =>
  "channel" in target
    ? { title: copy.dialogTitle.channel({ title: target.channel.title }), intro: copy.dialogIntro.channel }
    : {
        title: copy.dialogTitle.hob({ name: target.hob.name }),
        intro: copy.dialogIntro.hob({ name: target.hob.name }),
      };

/** Export from a channel's or a hob's menu: the same form as Settings › Export, for that one channel or hob. */
export function ExportDialog({ target, onClose }: { target: ExportTarget; onClose: () => void }) {
  const { title, intro } = textOf(target);
  const scope =
    "channel" in target
      ? ({ _tag: "Channel", channelId: target.channel.id } as const)
      : ({ _tag: "Hob", agentId: target.hob.id } as const);
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogTitle className="m-0 font-heading text-heading font-bold break-words text-moonlight">
          {title}
        </DialogTitle>
        <DialogDescription className="m-0 text-ui text-text-secondary">
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
