import type { MessageId, ThreadId } from "@hobbots/domain";
import { Button } from "@hobbots/ui/components/button";
import { useQuery } from "@tanstack/react-query";
import { charmCallsQuery, useSettleCharmCall } from "../../api/charm-calls.ts";
import { messages } from "../messages.ts";

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
      <span role="status" className="ps-5.5 text-meta text-text-secondary">
        {copy.settled[charmCall.state]}
      </span>
    );
  }
  return (
    <div className="flex flex-col gap-1.5 ps-5.5 pt-1">
      <span className="text-meta text-text-secondary">{copy.ask}</span>
      <SettleChoices pending={settle.isPending} onSettle={settle.mutate} />
      {settle.isError && (
        <p role="alert" className="m-0 text-meta text-rose">
          {copy.error}
        </p>
      )}
    </div>
  );
}

/**
 * The two ways to settle an uncertain Charm call, the same under a chat step, in a hob's work in a quest
 * and in the Inbox (ADR 038): it went through, or it did not.
 */
export function SettleChoices({
  pending,
  onSettle,
}: {
  pending: boolean;
  onSettle: (outcome: "applied" | "not-sent") => void;
}) {
  return (
    <div className="flex flex-wrap gap-2">
      <Button size="xs" variant="chip" disabled={pending} onClick={() => onSettle("applied")}>
        {copy.applied}
      </Button>
      <Button size="xs" variant="chip" disabled={pending} onClick={() => onSettle("not-sent")}>
        {copy.notSent}
      </Button>
    </div>
  );
}
