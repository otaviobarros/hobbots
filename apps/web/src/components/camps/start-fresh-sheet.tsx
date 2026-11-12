import { type Agent, type CarriedOverEntry, carriedOverRefId, type Thread, ThreadId } from "@hobbots/domain";
import { Button } from "@hobbots/ui/components/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@hobbots/ui/components/dialog";
import { Skeleton } from "@hobbots/ui/components/skeleton";
import { type UseQueryResult, useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useReducer } from "react";
import { carryOverQuery, useStartFresh } from "../../api/camps.ts";
import { AlongRow, ListedRow } from "./camp-parts.tsx";
import { messages } from "./messages.ts";
import { ASKING, canRetry, type StartFreshEvent, startFreshError, startFreshStep } from "./start-fresh-flow.ts";

const copy = messages.fresh;

/**
 * Start fresh on the hob's chat (ADR 037): the hob's memory and every open item come along, and
 * the sheet lists them first. The chat goes to the Archive and the new one opens; a refusal says why.
 */
export function StartFreshSheet({ hob, chat, onClose }: { hob: Agent; chat: Thread; onClose: () => void }) {
  const [state, dispatch] = useReducer(startFreshStep, ASKING);
  const carried = useQuery(carryOverQuery(chat.id));
  const start = useStartFresh();
  const navigate = useNavigate();
  const starting = state.step === "starting";
  const stuck = state.step === "failed" && !canRetry(state.error);

  const send = () => {
    // The reducer decides the key: a try again keeps the one it sent.
    const event: StartFreshEvent = { _tag: "Start", key: ThreadId.make(crypto.randomUUID()) };
    const next = startFreshStep(state, event);
    dispatch(event);
    if (next.step !== "starting") return;
    start.mutate(
      { thread: chat, key: next.key },
      {
        onSuccess: (started) => {
          onClose();
          void navigate({
            to: "/hobs/$hobId/threads/$threadId",
            params: { hobId: hob.id, threadId: started.chat.id },
          });
        },
        onError: (error) => dispatch({ _tag: "Failed", error: startFreshError(error) }),
      },
    );
  };

  return (
    <Dialog open onOpenChange={(open) => !open && !starting && onClose()}>
      {/* A long list of what comes along scrolls inside the sheet, which stays inside the window. */}
      <DialogContent variant="sheet" className="max-h-[calc(100vh-32px)] max-w-bubble-max">
        <DialogTitle variant="heading">{copy.title({ name: hob.name })}</DialogTitle>
        <DialogDescription variant="lead">{copy.lead}</DialogDescription>
        <section aria-label={copy.comesAlong} className="flex flex-col gap-1.5">
          <span className="lbl text-meta text-label">{copy.comesAlong}</span>
          <AlongRow title={copy.memory({ name: hob.name })} detail={copy.memoryAlways} checked />
          <CarriedList carried={carried} />
        </section>
        <span className="text-meta text-label">{copy.archiveNote}</span>
        {state.step === "failed" && (
          <p role="alert" className="m-0 text-ui text-rose">
            {copy.errors[state.error]({ name: hob.name })}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" disabled={starting} onClick={onClose}>
            {copy.cancel}
          </Button>
          <Button type="button" disabled={starting || stuck || !carried.isSuccess} onClick={send}>
            {starting ? copy.starting : state.step === "failed" ? copy.tryAgain : copy.start}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** The open items that move to the new chat, with how many, read as the sheet opens. */
function CarriedList({ carried }: { carried: UseQueryResult<ReadonlyArray<CarriedOverEntry>> }) {
  if (carried.isPending) {
    return (
      <span role="status" className="flex flex-col gap-1.5">
        <span className="sr-only">{copy.loading}</span>
        <Skeleton width="100%" />
      </span>
    );
  }
  if (carried.isError) {
    return (
      <span className="flex items-center gap-2 text-meta text-rose">
        <span role="alert">{copy.loadFailed}</span>
        <Button type="button" variant="outline" size="xs" onClick={() => void carried.refetch()}>
          {copy.retryLoad}
        </Button>
      </span>
    );
  }
  return (
    <>
      {carried.data.length > 0 && (
        <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
          {carried.data.map((item) => (
            <ListedRow
              key={`${item.ref._tag}-${carriedOverRefId(item.ref)}`}
              title={item.label}
              detail={copy.kind[item.ref._tag]}
            />
          ))}
        </ul>
      )}
      <span className="text-meta text-label">{copy.count({ count: carried.data.length })}</span>
    </>
  );
}
