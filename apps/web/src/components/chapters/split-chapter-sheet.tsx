import type { Agent } from "@hobbots/domain";
import { Button } from "@hobbots/ui/components/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@hobbots/ui/components/dialog";
import { Input } from "@hobbots/ui/components/input";
import { type FormEvent, useId } from "react";
import { canRetry, type SplitChapter, type SplitChapterEvent, titleProblem } from "./chapter-flows.ts";
import { messages } from "./messages.ts";

const copy = messages.split;

/**
 * Split here (ADR 037): the new chapter's title, then the split. A failure keeps the title and says
 * why; a lost answer can be tried again under the same key.
 */
export function SplitChapterSheet({
  hob,
  state,
  dispatch,
  onSend,
}: {
  hob: Agent;
  state: Exclude<SplitChapter, { step: "closed" }>;
  dispatch: (event: SplitChapterEvent) => void;
  onSend: () => void;
}) {
  const id = useId();
  const splitting = state.step === "splitting";
  const problem = state.step === "naming" && state.shown ? titleProblem(state.title) : null;
  const close = (open: boolean) => {
    if (!open && !splitting) dispatch({ _tag: "Close" });
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    onSend();
  };
  return (
    <Dialog open onOpenChange={close}>
      <DialogContent variant="sheet" className="max-w-bubble-max" aria-describedby={`${id}-lead`}>
        <DialogTitle variant="heading">{copy.title}</DialogTitle>
        <DialogDescription id={`${id}-lead`} variant="lead">
          {copy.lead({ name: hob.name })}
        </DialogDescription>
        <form noValidate className="flex flex-col gap-3.5" onSubmit={submit}>
          <div className="flex flex-col gap-1.5">
            <label htmlFor={id} className="lbl text-meta text-label">
              {copy.name}
            </label>
            <Input
              id={id}
              value={state.title}
              autoComplete="off"
              disabled={splitting}
              placeholder={copy.placeholder}
              aria-invalid={problem !== null}
              aria-describedby={problem === null ? undefined : `${id}-problem`}
              onChange={(event) => dispatch({ _tag: "Edit", title: event.target.value })}
            />
            {problem !== null && (
              <span id={`${id}-problem`} role="alert" className="text-meta text-rose">
                {copy.problems[problem]}
              </span>
            )}
          </div>
          {state.step === "failed" && (
            <p role="alert" className="m-0 text-ui text-rose">
              {messages.errors[state.error]()}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" disabled={splitting} onClick={() => close(false)}>
              {copy.cancel}
            </Button>
            {(state.step !== "failed" || canRetry(state.error)) && (
              <Button type="submit" disabled={splitting}>
                {splitting ? copy.splitting : state.step === "failed" ? copy.tryAgain : copy.split}
              </Button>
            )}
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
