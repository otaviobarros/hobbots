import type { RetireAgentPayload } from "@hobbots/api";
import { type Agent, type AgentId, takesNewWork } from "@hobbots/domain";
import { Button } from "@hobbots/ui/components/button";
import { Dialog, DialogContent, DialogTitle } from "@hobbots/ui/components/dialog";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import {
  type RetireChoice,
  retireChoiceCopy,
  retireChoices,
  retiredSummary,
  retirePayload,
} from "../../api/profile.ts";
import { agentsQuery, openWorkQuery, useRetireHob } from "../../api/queries.ts";
import { messages } from "../messages.ts";
import { HandOverPicker, OpenWorkList, RetireChoiceRow } from "./retire-parts.tsx";

/** A hob the profile retired, with the choice made, whether it had replies running and who took its Tasks. */
export interface Retired {
  readonly hob: Agent;
  readonly choice: RetireChoice;
  readonly busy: boolean;
  readonly taker: string | null;
}

/** Which way to retire is picked, what it would send, and whether it can be sent yet. */
function useRetirePlan(hob: Agent) {
  const [handOverTo, setHandOverTo] = useState<AgentId | null>(null);
  const [picked, setPicked] = useState<RetireChoice | null>(null);
  const work = useQuery(openWorkQuery(hob.id, handOverTo));
  const hobs = useQuery(agentsQuery);
  const takers = (hobs.data ?? []).filter((each) => each.id !== hob.id && takesNewWork(each));
  const openTasks = work.data?.tasks.length ?? 0;
  const offered = retireChoices(openTasks, hob.retiring !== null);
  const choice = picked !== null && offered.includes(picked) ? picked : (offered[0] ?? "finish");
  const handingOver = choice === "hand-over";
  const blocked = handingOver ? (work.data?.tasks ?? []).filter((each) => each.handOver != null) : [];
  const payload = retirePayload(choice, handOverTo);
  // A hand-over waits for the open Tasks to be checked against the hob picked.
  const checked = !handingOver || (!work.isPlaceholderData && blocked.length === 0);
  return {
    work,
    takers,
    openTasks,
    offered,
    choice,
    setPicked,
    handOverTo,
    setHandOverTo,
    taker: takers.find((each) => each.id === handOverTo) ?? null,
    blocked: blocked.length,
    payload,
    ready: payload !== null && work.isSuccess && checked,
  };
}

/**
 * Lists what the hob still has open, asks how it retires, then retires it (#408). With open Tasks
 * it can finish them first, hand them to another hob, or stop. Nothing is deleted; the hob goes to
 * Archived hobs, at once or once its last Task ends. Once retired it says the hob is asleep, and
 * closing goes Home; a hob finishing first stays, so closing just closes.
 */
export function RetireDialog({
  hob,
  running,
  retired,
  onRetiring,
  onRetired,
  onClose,
}: {
  hob: Agent;
  running: ReadonlyArray<string>;
  retired: Retired | null;
  onRetiring: (hob: Agent) => void;
  onRetired: (retired: Retired) => void;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const retire = useRetireHob(hob.id);
  const [waiting, setWaiting] = useState<Retired | null>(null);
  const done = retired ?? waiting;

  // Once retired the profile has nothing left to show, so closing goes Home.
  const close = () => {
    if (retired) void navigate({ to: "/" });
    else if (!retire.isPending) onClose();
  };

  const send = (outcome: Omit<Retired, "hob">, payload: RetireAgentPayload) => {
    if (outcome.choice !== "finish-first") onRetiring(hob);
    retire.mutate(payload, {
      onSuccess: (next) => (next.status === "retired" ? onRetired : setWaiting)({ ...outcome, hob: next }),
    });
  };

  return (
    <Dialog open onOpenChange={(open) => !open && close()}>
      <DialogContent aria-describedby={undefined} variant="sheet" className="max-w-bubble-max">
        {done ? (
          <RetireDone name={hob.name} done={done} onHome={close} onClose={onClose} />
        ) : (
          <RetireAsk
            hob={hob}
            running={running}
            pending={retire.isPending}
            failed={retire.isError}
            onSend={send}
            onKeep={close}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

/** The question: what the hob has open, the ways it can retire, and the hob to hand its Tasks to. */
function RetireAsk({
  hob,
  running,
  pending,
  failed,
  onSend,
  onKeep,
}: {
  hob: Agent;
  running: ReadonlyArray<string>;
  pending: boolean;
  failed: boolean;
  onSend: (outcome: Omit<Retired, "hob">, payload: RetireAgentPayload) => void;
  onKeep: () => void;
}) {
  const plan = useRetirePlan(hob);
  const copy = messages.profile.retire;
  const name = hob.name;
  const busy = running.length > 0;
  const lead = plan.openTasks > 0 ? copy.open({ name }) : busy ? copy.busy({ name }) : copy.idle({ name });
  const confirm = () => {
    if (plan.payload !== null) onSend({ choice: plan.choice, busy, taker: plan.taker?.name ?? null }, plan.payload);
  };
  return (
    <>
      <DialogTitle variant="heading">{copy.title({ name })}</DialogTitle>
      <span className="text-ui text-text-secondary">{lead}</span>
      <OpenWorkList
        running={running}
        work={plan.work.data}
        blockedTaker={plan.choice === "hand-over" ? plan.taker : null}
      />
      {plan.work.isError && (
        <span role="alert" className="text-ui text-rose">
          {copy.unread({ name })}
        </span>
      )}
      <fieldset disabled={pending} className="m-0 flex flex-col gap-2 border-0 p-0">
        <legend className="sr-only">{copy.choices({ name })}</legend>
        {plan.offered.map((each) => (
          <RetireChoiceRow
            key={each}
            checked={plan.choice === each}
            {...retireChoiceCopy(each, name, plan.openTasks > 0)}
            onPick={() => plan.setPicked(each)}
          />
        ))}
      </fieldset>
      {plan.choice === "hand-over" && (
        <HandOverPicker
          takers={plan.takers}
          value={plan.handOverTo}
          disabled={pending}
          onPick={plan.setHandOverTo}
          blocked={plan.blocked}
          taker={plan.taker?.name ?? null}
        />
      )}
      <span className="text-detail text-label">{copy.kept}</span>
      {failed && (
        <span role="alert" className="text-ui text-rose">
          {copy.failed({ name })}
        </span>
      )}
      <div className="flex justify-end gap-2">
        <Button variant="outline" onClick={onKeep} disabled={pending}>
          {copy.keep({ name })}
        </Button>
        <Button variant="deny" onClick={confirm} disabled={pending || !plan.ready}>
          {pending ? copy.retiring : copy.confirm({ name })}
        </Button>
      </div>
    </>
  );
}

/** What Retire says once it is done: the hob asleep, with the way to the Archive and Home, or retiring when done. */
function RetireDone({
  name,
  done,
  onHome,
  onClose,
}: {
  name: string;
  done: Retired;
  onHome: () => void;
  onClose: () => void;
}) {
  const copy = messages.profile.retire;
  const asleep = done.hob.status === "retired";
  return (
    <>
      <DialogTitle variant="heading">{asleep ? copy.done({ name }) : copy.waiting({ name })}</DialogTitle>
      <p role="status" className="m-0 text-ui text-text-secondary">
        {retiredSummary(name, done.choice, done.busy, done.taker)}{" "}
        {asleep ? copy.find({ name }) : copy.whenDone({ name })}
      </p>
      <div className="flex justify-end gap-2">
        {asleep ? (
          <>
            <Button asChild variant="outline">
              <Link to="/archive" search={{ tab: "hobs" }}>
                {copy.archived}
              </Link>
            </Button>
            <Button onClick={onHome}>{copy.home}</Button>
          </>
        ) : (
          <Button onClick={onClose}>{copy.close}</Button>
        )}
      </div>
    </>
  );
}
