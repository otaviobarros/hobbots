import { type Agent, ThreadId } from "@hobbots/domain";
import { Button } from "@hobbots/ui/components/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@hobbots/ui/components/dialog";
import { Input } from "@hobbots/ui/components/input";
import { Textarea } from "@hobbots/ui/components/textarea";
import { useNavigate } from "@tanstack/react-router";
import { useReducer } from "react";
import { useMakeCamp } from "../../api/camps.ts";
import { AlongRow, CampField } from "./camp-parts.tsx";
import {
  type CampDraft,
  campPayload,
  campProblems,
  type MakeCampEvent,
  makeCampError,
  makeCampStep,
  startMakeCamp,
} from "./make-camp-flow.ts";
import { messages } from "./messages.ts";

const copy = messages.make;

/**
 * Make a camp (ADR 037): its name, its goal and whether it is private, with the hob's memory always
 * coming along. The camp opens once it is made; a failure keeps what you typed and says why.
 */
export function MakeCampSheet({ hob, onClose }: { hob: Agent; onClose: () => void }) {
  const [state, dispatch] = useReducer(makeCampStep, undefined, () => startMakeCamp());
  const make = useMakeCamp(hob.id);
  const navigate = useNavigate();
  const { draft } = state;
  const saving = state.step === "saving";
  const problems = campProblems(draft);
  // A field's problem shows once it lost focus, or once a send found it.
  const problemOf = (field: keyof CampDraft) => {
    const problem = problems[field];
    return problem !== undefined && state.step === "editing" && state.shown.has(field)
      ? copy.problems[problem]
      : undefined;
  };
  const edit = (change: Partial<CampDraft>) => dispatch({ _tag: "Edit", draft: { ...draft, ...change } });

  const send = () => {
    // The reducer decides whether it saves and under which key; the request follows its answer.
    const event: MakeCampEvent = { _tag: "Send", key: ThreadId.make(crypto.randomUUID()) };
    const next = makeCampStep(state, event);
    dispatch(event);
    if (next.step !== "saving") return;
    make.mutate(campPayload(next.draft, next.key), {
      onSuccess: (camp) => {
        onClose();
        void navigate({ to: "/hobs/$hobId/threads/$threadId", params: { hobId: hob.id, threadId: camp.id } });
      },
      onError: (error) => dispatch({ _tag: "Failed", error: makeCampError(error) }),
    });
  };

  return (
    <Dialog open onOpenChange={(open) => !open && !saving && onClose()}>
      <DialogContent variant="sheet" className="max-w-bubble-max">
        <DialogTitle variant="heading">{copy.title}</DialogTitle>
        <DialogDescription variant="lead">{copy.lead({ name: hob.name })}</DialogDescription>
        <form
          noValidate
          className="flex flex-col gap-3.5"
          onSubmit={(event) => {
            event.preventDefault();
            send();
          }}
        >
          <fieldset disabled={saving} className="m-0 flex flex-col gap-3.5 border-0 p-0">
            <CampField label={copy.name} problem={problemOf("title")}>
              {({ id, noteId }) => (
                <Input
                  id={id}
                  value={draft.title}
                  autoComplete="off"
                  placeholder={copy.namePlaceholder}
                  aria-invalid={problemOf("title") !== undefined}
                  aria-describedby={noteId}
                  onBlur={() => dispatch({ _tag: "Leave", field: "title" })}
                  onChange={(event) => edit({ title: event.target.value })}
                />
              )}
            </CampField>
            <CampField label={copy.goal} note={copy.goalHint({ name: hob.name })} problem={problemOf("goal")}>
              {({ id, noteId }) => (
                <Textarea
                  id={id}
                  rows={2}
                  value={draft.goal}
                  placeholder={copy.goalPlaceholder}
                  aria-invalid={problemOf("goal") !== undefined}
                  aria-describedby={noteId}
                  onBlur={() => dispatch({ _tag: "Leave", field: "goal" })}
                  onChange={(event) => edit({ goal: event.target.value })}
                />
              )}
            </CampField>
            <section aria-label={copy.comesAlong} className="flex flex-col gap-1.5">
              <span className="lbl text-meta text-label">{copy.comesAlong}</span>
              <AlongRow title={copy.memory({ name: hob.name })} detail={copy.memoryAlways} checked />
            </section>
            <AlongRow
              title={copy.private}
              detail={draft.private ? copy.privateOn({ name: hob.name }) : copy.privateOff({ name: hob.name })}
              checked={draft.private}
              onChange={(value) => edit({ private: value })}
            />
          </fieldset>
          {state.step === "failed" && (
            <p role="alert" className="m-0 text-ui text-rose">
              {copy.errors[state.error]({ name: hob.name })}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" disabled={saving} onClick={onClose}>
              {copy.cancel}
            </Button>
            <Button type="submit" disabled={saving}>
              {saving ? copy.making : copy.make}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
