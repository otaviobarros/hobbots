import { type BackpackBlocker, type BackpackItem, openBlocker } from "@hobbots/domain";
import { Button } from "@hobbots/ui/components/button";
import { type ReactNode, useRef } from "react";
import { useDecideBlocker } from "../../api/blockers.ts";
import { ApiError } from "../../api/client.ts";
import type { FocusTargets } from "../move-on/follow-focus.ts";
import { useMoveOn } from "../move-on/move-on.tsx";
import type { HobLookup } from "../quest/use-work.ts";
import { BlockerReassign } from "./blocker-reassign.tsx";
import { messages } from "./messages.ts";

const copy = messages;

type Hob = ReturnType<HobLookup>;

/** Why a choice on stuck work was not saved, in the card's words: the hob retired, or it did not reach the hub. */
export const blockerError = (error: unknown, name: string): string =>
  error instanceof ApiError && error.tag === "HobUnavailable" ? copy.retired({ name }) : copy.failed;

/** An item's open blocker, whether its hob retired, and so the action it suggests next. */
export const blockerChoice = (
  item: BackpackItem,
  hob: Hob,
): {
  readonly blocker: BackpackBlocker;
  readonly retired: boolean;
  readonly next: "retry" | "reassign" | "dismiss";
} | null => {
  const blocker = openBlocker(item);
  if (blocker === undefined) return null;
  // Nobody can take it again once its hob retired, whatever ended its tries.
  const retired = blocker.reason === "recipient-retired" || ("status" in hob && hob.status === "retired");
  return { blocker, retired, next: retired ? "dismiss" : blocker.nextAction };
};

/**
 * Retry, Reassign… and Dismiss for a stuck item, bound to the blocker shown, with what went wrong
 * when a choice could not be saved. `children` joins the buttons' row. Reassign… shows while the
 * item's Task can change hands, as the lane's ⋯ menu offers it (#1087); without `reassign` it is
 * left out. With `targets`, the card leaves once a choice is sent: focus moves there and a toast
 * says what was sent (#988).
 */
export function BlockerChoices({
  item,
  hob,
  reassign = true,
  targets,
  children,
}: {
  item: BackpackItem;
  hob: Hob;
  reassign?: boolean;
  targets?: FocusTargets;
  children?: ReactNode;
}) {
  const decide = useDecideBlocker();
  const area = useRef<HTMLDivElement>(null);
  const moveOn = useMoveOn();
  const choice = blockerChoice(item, hob);
  if (choice === null) return null;
  const { blocker, retired, next } = choice;
  const follow = (sent: Promise<unknown>, say: string) => {
    if (targets === undefined) sent.catch(() => undefined);
    else moveOn({ from: area.current, targets, sent, say });
  };
  const choose = (action: "retry" | "dismiss") =>
    follow(decide.mutateAsync({ item, blocker: blocker.number, action }), copy.decided[action]({ name: hob.name }));
  return (
    <div ref={area} className="contents">
      <div className="flex flex-wrap items-center gap-2">
        {!retired && (
          <Button
            size="xs"
            variant={next === "retry" ? "default" : "outline"}
            disabled={decide.isPending}
            onClick={() => choose("retry")}
          >
            {copy.retry}
          </Button>
        )}
        {reassign && item.threadId !== null && (
          <BlockerReassign
            item={item}
            threadId={item.threadId}
            owner={hob.name}
            disabled={decide.isPending}
            onSent={(sent, to) => follow(sent, copy.decided.reassign({ name: to.name }))}
          />
        )}
        <Button
          size="xs"
          variant={next === "dismiss" ? "default" : "outline"}
          disabled={decide.isPending}
          onClick={() => choose("dismiss")}
        >
          {copy.dismiss}
        </Button>
        {children}
      </div>
      {decide.isError && (
        <p role="alert" className="m-0 text-meta text-rose">
          {blockerError(decide.error, hob.name)}
        </p>
      )}
    </div>
  );
}
