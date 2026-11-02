import { type BackpackBlocker, type BackpackItem, openBlocker } from "@hobbots/domain";
import { Button } from "@hobbots/ui/components/button";
import { type ReactNode, useId } from "react";
import { useDecideBlocker } from "../../api/blockers.ts";
import { ApiError } from "../../api/client.ts";
import type { HobLookup } from "../quest/use-work.ts";
import { messages } from "./messages.ts";

const copy = messages;

type Hob = ReturnType<HobLookup>;

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
 * Retry, Reassign and Dismiss for a stuck item, bound to the blocker shown, with why Reassign is
 * held and what went wrong when a choice could not be saved. `children` joins the buttons' row.
 */
export function BlockerChoices({ item, hob, children }: { item: BackpackItem; hob: Hob; children?: ReactNode }) {
  const decide = useDecideBlocker(item);
  const held = useId();
  const choice = blockerChoice(item, hob);
  if (choice === null) return null;
  const { blocker, retired, next } = choice;
  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        {!retired && (
          <Button
            size="xs"
            variant={next === "retry" ? "default" : "outline"}
            disabled={decide.isPending}
            onClick={() => decide.mutate({ blocker: blocker.number, action: "retry" })}
          >
            {copy.retry}
          </Button>
        )}
        <Button size="xs" variant="outline" disabled aria-describedby={held}>
          {copy.reassign}
        </Button>
        <Button
          size="xs"
          variant={next === "dismiss" ? "default" : "outline"}
          disabled={decide.isPending}
          onClick={() => decide.mutate({ blocker: blocker.number, action: "dismiss" })}
        >
          {copy.dismiss}
        </Button>
        {children}
      </div>
      <p id={held} className="m-0 text-xs text-label">
        {copy.reassignHeld}
      </p>
      {decide.isError && (
        <p role="alert" className="m-0 text-xs text-rose">
          {decide.error instanceof ApiError && decide.error.tag === "HobUnavailable"
            ? copy.retired({ name: hob.name })
            : copy.failed}
        </p>
      )}
    </>
  );
}
