import { type Decision, DecisionStates, type Thread } from "@hobbots/domain";
import { Button } from "@hobbots/ui/components/button";
import { Textarea } from "@hobbots/ui/components/textarea";
import { cn } from "@hobbots/ui/lib/utils";
import { useQuery } from "@tanstack/react-query";
import { type Dispatch, useId, useReducer } from "react";
import { decisionsQuery, useCrossOutDecision, useRecordDecision } from "../../api/records.ts";
import { formatAgo } from "../../lib/format.ts";
import {
  DECISION_FORM_CLOSED,
  type DecisionForm,
  type DecisionFormEvent,
  decisionFormStep,
  decisionProblem,
  recordDecisionError,
} from "./decision-flow.ts";
import { messages } from "./messages.ts";
import { ReadState } from "./sheet-parts.tsx";

const copy = messages.decisions;

/**
 * The Decisions tab (ADR 037): every decision, newest first, crossed-out ones kept with what changed
 * them. You add one, change one, which crosses the old one out, or cross one out.
 */
export function DecisionsTab({ thread, hobName }: { thread: Thread; hobName: string }) {
  const decisions = useQuery(decisionsQuery(thread.id));
  const [form, dispatch] = useReducer(decisionFormStep, DECISION_FORM_CLOSED);
  const record = useRecordDecision(thread.id);
  const crossOut = useCrossOutDecision(thread.id);
  const list = decisions.data ?? [];

  const send = () => {
    // The reducer decides whether it saves and under which key; the request follows its answer.
    const event: DecisionFormEvent = { _tag: "Send", key: crypto.randomUUID() };
    const next = decisionFormStep(form, event);
    dispatch(event);
    if (next.step !== "saving") return;
    record.mutate(
      { key: next.key, text: next.text.trim(), replaces: next.replaces?.id ?? null },
      {
        onSuccess: () => dispatch({ _tag: "Saved" }),
        onError: (error) => dispatch({ _tag: "Failed", error: recordDecisionError(error) }),
      },
    );
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <span className="lbl flex-1 text-meta text-label">{copy.newestFirst}</span>
        {form.step === "closed" && (
          <Button variant="outline" size="xs" onClick={() => dispatch({ _tag: "Open", replaces: null })}>
            {copy.add}
          </Button>
        )}
      </div>
      {form.step !== "closed" && <DecisionEditor form={form} dispatch={dispatch} onSend={send} />}
      <ReadState read={decisions} empty={list.length === 0 ? copy.empty : undefined} />
      <ul className="m-0 flex list-none flex-col gap-1 p-0">
        {list.map((decision) => (
          <DecisionRow
            key={decision.id}
            decision={decision}
            changedTo={list.find((each) => each.id === decision.supersededBy)}
            hobName={hobName}
            crossing={crossOut.isPending && crossOut.variables === decision.id}
            onChange={() => dispatch({ _tag: "Open", replaces: decision })}
            onCrossOut={() => crossOut.mutate(decision.id)}
          />
        ))}
      </ul>
      {crossOut.isError && (
        <p role="alert" className="m-0 text-ui text-rose">
          {copy.crossFailed}
        </p>
      )}
      <p className="m-0 text-meta text-label">{copy.footnote}</p>
    </div>
  );
}

function DecisionEditor({
  form,
  dispatch,
  onSend,
}: {
  form: Exclude<DecisionForm, { readonly step: "closed" }>;
  dispatch: Dispatch<DecisionFormEvent>;
  onSend: () => void;
}) {
  const id = useId();
  const saving = form.step === "saving";
  const problem = form.step === "writing" && form.shown ? decisionProblem(form.text) : null;
  return (
    <form
      noValidate
      aria-label={copy.field}
      className="flex flex-col gap-2 rounded-control bg-card p-3 border-(length:--edge) border-line"
      onSubmit={(event) => {
        event.preventDefault();
        onSend();
      }}
    >
      <label htmlFor={id} className="lbl text-meta text-label">
        {copy.field}
      </label>
      <Textarea
        id={id}
        rows={2}
        value={form.text}
        disabled={saving}
        placeholder={copy.placeholder}
        aria-invalid={problem !== null}
        aria-describedby={`${id}-note`}
        onChange={(event) => dispatch({ _tag: "Edit", text: event.target.value })}
      />
      <span id={`${id}-note`} role={problem === null ? undefined : "alert"} className="text-meta text-label">
        {problem !== null ? (
          <span className="text-rose">{copy.problems[problem]}</span>
        ) : (
          form.replaces !== null && copy.replacing({ text: form.replaces.text })
        )}
      </span>
      {form.step === "failed" && (
        <p role="alert" className="m-0 text-ui text-rose">
          {copy.errors[form.error]}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" size="xs" disabled={saving} onClick={() => dispatch({ _tag: "Close" })}>
          {copy.cancel}
        </Button>
        <Button type="submit" size="xs" disabled={saving}>
          {saving ? copy.saving : form.step === "failed" ? copy.tryAgain : copy.save}
        </Button>
      </div>
    </form>
  );
}

function DecisionRow({
  decision,
  changedTo,
  hobName,
  crossing,
  onChange,
  onCrossOut,
}: {
  decision: Decision;
  changedTo: Decision | undefined;
  hobName: string;
  crossing: boolean;
  onChange: () => void;
  onCrossOut: () => void;
}) {
  const active = DecisionStates.isActive(decision);
  const who = decision.actor.kind === "user" ? copy.byYou : hobName;
  return (
    <li className="flex gap-2.5 rounded-control px-2 py-2 hover:bg-hover">
      <span aria-hidden className={cn("mt-0.5 text-meta", active ? "text-lantern" : "text-label")}>
        {messages.mark}
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className={cn("text-ui", active ? "text-text-strong" : "text-label line-through")}>{decision.text}</span>
        {!active && (
          <span className="text-meta text-label">
            {changedTo === undefined ? copy.crossedOut : copy.changedTo({ text: changedTo.text })}
          </span>
        )}
        <span className="text-meta text-label">{copy.byline({ who, when: formatAgo(decision.recordedAt) })}</span>
      </span>
      {active && (
        <span className="flex shrink-0 items-start gap-1">
          <Button variant="text" size="xs" aria-label={copy.changeOf({ text: decision.text })} onClick={onChange}>
            {copy.change}
          </Button>
          <Button
            variant="text"
            size="xs"
            disabled={crossing}
            aria-label={copy.crossOutOf({ text: decision.text })}
            onClick={onCrossOut}
          >
            {crossing ? copy.crossing : copy.crossOut}
          </Button>
        </span>
      )}
    </li>
  );
}
