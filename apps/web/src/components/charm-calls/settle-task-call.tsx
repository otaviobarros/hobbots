import type { WaitingCharmCall } from "@hobbots/api";
import { useRef } from "react";
import { useSettleTaskCharmCall } from "../../api/charm-calls.ts";
import { SettleChoices } from "../chat/settle-charm-call.tsx";
import { messages } from "../messages.ts";
import type { FocusTargets } from "../move-on/follow-focus.ts";
import { useMoveOn } from "../move-on/move-on.tsx";

const copy = messages.charmCall;

/**
 * Settling a write a Task's session made whose answer is still uncertain (ADR 038), in the Quest
 * room's lane and in the Inbox alike: what to do, the two choices, and why the hub refused. Once
 * settled the call leaves both, focus moves on to `targets`, and a toast says how it settled.
 */
export function SettleTaskCall({ waiting, targets }: { waiting: WaitingCharmCall; targets: FocusTargets }) {
  const { call, task } = waiting;
  const settle = useSettleTaskCharmCall(task.id, call.attempt);
  const controls = useRef<HTMLDivElement>(null);
  const moveOn = useMoveOn();
  const send = (outcome: "applied" | "not-sent") =>
    moveOn({ from: controls.current, targets, sent: settle.mutateAsync(outcome), say: copy.settled[outcome] });
  return (
    <div ref={controls} className="flex flex-col gap-1.5">
      <span className="text-meta text-text-secondary">{copy.ask}</span>
      <SettleChoices pending={settle.isPending || settle.isSuccess} onSettle={send} />
      {settle.isError && (
        <p role="alert" className="m-0 text-meta text-rose">
          {copy.errorTask}
        </p>
      )}
    </div>
  );
}

/** What the write was, in words: which call on which site lost its answer. */
export const lostWhat = ({ call }: WaitingCharmCall): string =>
  copy.lostWhat({ charm: call.charm, tool: call.tool, site: call.site });
