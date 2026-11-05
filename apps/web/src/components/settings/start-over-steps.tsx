import { Button } from "@hobbots/ui/components/button";
import { DialogDescription, DialogTitle } from "@hobbots/ui/components/dialog";
import { Progress } from "@hobbots/ui/components/progress";
import type { StartOverStep } from "../../api/backup.ts";
import { messages } from "./messages.ts";

const copy = messages.startOver;

/** The steps the deleting dialog lists, in the order the hub takes them. */
const STEPS = ["signIns", "stopping", "deleting"] as const satisfies ReadonlyArray<StartOverStep>;

/** Each step with its mark: done, under way, or still to come. */
export function Deleting({ step }: { step: StartOverStep }) {
  const at = STEPS.indexOf(step as (typeof STEPS)[number]);
  return (
    <>
      <DialogTitle variant="heading">{copy.deletingTitle}</DialogTitle>
      <DialogDescription id="start-over-lead" variant="lead">
        {copy.deletingNote}
      </DialogDescription>
      <Progress value={at} max={STEPS.length} aria-label={copy.deletingTitle} />
      <ul role="status" className="m-0 flex list-none flex-col gap-1.5 p-0 text-ui">
        {STEPS.map((each, index) => (
          <li key={each} className={index <= at ? "flex gap-2 text-text" : "flex gap-2 text-label"}>
            <span aria-hidden className={index < at ? "w-4 text-mint" : "w-4 text-label"}>
              {index < at ? "✓" : index === at ? "·" : "○"}
            </span>
            {index === at ? `${copy.steps[each]}…` : copy.steps[each]}
          </li>
        ))}
      </ul>
    </>
  );
}

/** The hub answers again, empty: Start fresh opens the app at its root, which is Welcome on a new hub. */
export function AllClear() {
  return (
    <>
      <span aria-hidden className="grid size-9 place-items-center rounded-full bg-mint/18 text-[18px] text-mint">
        ✓
      </span>
      <DialogTitle variant="heading">{copy.doneTitle}</DialogTitle>
      <DialogDescription id="start-over-lead" variant="lead">
        {copy.doneBody}
      </DialogDescription>
      <div className="flex justify-end">
        <Button onClick={() => globalThis.location.assign(`${globalThis.location.origin}/`)}>{copy.startFresh}</Button>
      </div>
    </>
  );
}

export function Failed({ reason, onClose }: { reason: string; onClose: () => void }) {
  return (
    <>
      <DialogTitle variant="heading">{copy.title}</DialogTitle>
      <DialogDescription id="start-over-lead" role="alert" variant="alert">
        {copy.failed({ reason })}
      </DialogDescription>
      <div className="flex justify-end">
        <Button variant="outline" onClick={onClose}>
          {copy.close}
        </Button>
      </div>
    </>
  );
}
