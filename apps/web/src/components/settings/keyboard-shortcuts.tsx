import { Button } from "@hobbots/ui/components/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@hobbots/ui/components/dialog";
import { isMac } from "../archive/archive-rules.ts";
import { messages } from "./messages.ts";

const copy = messages.shortcuts;

/** Every keyboard shortcut Hobbots has, with the keys this computer uses (⌘ on a Mac, Ctrl elsewhere). */
export function KeyboardShortcuts({ onClose }: { onClose: () => void }) {
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogTitle className="m-0 font-heading text-heading font-(--heading-weight) text-text-strong">
          {copy.title}
        </DialogTitle>
        <DialogDescription className="m-0 text-sm text-text-secondary">{copy.intro}</DialogDescription>
        <dl className="m-0 grid grid-cols-[auto_1fr] items-baseline gap-x-4 gap-y-2.5 text-sm">
          {copy.list({ mac: isMac() }).map(({ keys, does }) => (
            <div key={does} className="contents">
              <dt className="flex gap-1">
                {keys.map((key) => (
                  <kbd
                    key={key}
                    className="rounded-tag bg-line px-1.5 py-0.5 font-mono text-detail whitespace-nowrap text-text-strong"
                  >
                    {key}
                  </kbd>
                ))}
              </dt>
              <dd className="m-0 text-text">{does}</dd>
            </div>
          ))}
        </dl>
        <div className="flex justify-end">
          <Button variant="outline" onClick={onClose}>
            {copy.close}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
