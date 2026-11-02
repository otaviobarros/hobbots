import type { MessageId, ThreadId } from "@hobbots/domain";
import { Button } from "@hobbots/ui/components/button";
import { useQuery } from "@tanstack/react-query";
import { charmCallsQuery, useSettleCharmCall } from "../api/charm-calls.ts";
import { messages } from "./messages.ts";

const copy = messages.charmCall;

/**
 * Under an uncertain Charm step, such as a GitHub push whose answer was lost (ADR 020): Hobbots keeps
 * reading GitHub back, and the user can settle it after looking there. Until then no hob makes the
 * same call to the same place. Shows nothing for a step that is not a Charm call.
 */
export function SettleCharmCall({
  threadId,
  messageId,
  stepId,
}: {
  threadId: ThreadId;
  messageId: MessageId;
  stepId: string;
}) {
  const charmCall = useQuery({
    ...charmCallsQuery(threadId),
    select: (all) => all.find((c) => c.messageId === messageId && c.stepId === stepId),
  }).data;
  const settle = useSettleCharmCall(threadId, messageId, stepId);
  if (charmCall === undefined) return null;
  if (charmCall.state !== "uncertain" && charmCall.state !== "sending") {
    return (
      <span role="status" className="ps-5.5 text-xs text-secondary-text">
        {copy.settled[charmCall.state]}
      </span>
    );
  }
  return (
    <div className="flex flex-col gap-1.5 ps-5.5 pt-1">
      <span className="text-xs text-secondary-text">{copy.ask}</span>
      <div className="flex flex-wrap gap-2">
        <Button size="xs" variant="chip" disabled={settle.isPending} onClick={() => settle.mutate("applied")}>
          {copy.applied}
        </Button>
        <Button size="xs" variant="chip" disabled={settle.isPending} onClick={() => settle.mutate("not-sent")}>
          {copy.notSent}
        </Button>
      </div>
      {settle.isError && (
        <p role="alert" className="m-0 text-xs text-rose">
          {copy.error}
        </p>
      )}
    </div>
  );
}
