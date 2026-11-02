import type { BackpackItem } from "@hobbots/domain";
import { Badge } from "@hobbots/ui/components/badge";
import { Link } from "@tanstack/react-router";
import { HobSprite } from "../hob-sprite.tsx";
import type { HobLookup } from "../quest/use-work.ts";
import { BlockerChoices, blockerChoice } from "./blocker-choices.tsx";
import { blockerWhat, blockerWhy } from "./blocker-model.ts";
import { messages } from "./messages.ts";

const copy = messages;

/**
 * Work that failed as a blocker (IN-007): what it was, why it stopped, the next action, and Retry,
 * Reassign and Dismiss. Reassign stays disabled until a Task can change owners. `inChat` leaves
 * out the link to the chat, for a card already shown there.
 */
export function BlockerCard({ item, hobs, inChat = false }: { item: BackpackItem; hobs: HobLookup; inChat?: boolean }) {
  const hob = hobs(item.recipientId);
  const choice = blockerChoice(item, hob);
  if (choice === null) return null;
  const what = blockerWhat(item);
  return (
    <section
      aria-label={copy.label({ name: hob.name, what })}
      className="cut flex flex-col gap-2 border-2 border-rose bg-card px-3 py-2.5"
    >
      <div className="flex items-center gap-2">
        <HobSprite hob={hob} size={20} state="needs-you" />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="text-sm font-bold">{copy.title({ name: hob.name })}</span>
          <span className="truncate text-detail text-secondary-text">{what}</span>
        </span>
        <Badge variant="failed">{copy.heading}</Badge>
      </div>
      <p className="m-0 text-detail leading-snug">{blockerWhy(item, choice.blocker, hob.name)}</p>
      {choice.blocker.diagnostic !== null && (
        <p className="m-0 text-xs break-words text-label">
          {copy.diagnostic} <span className="font-mono">{choice.blocker.diagnostic}</span>
        </p>
      )}
      <p className="m-0 text-detail font-bold text-lantern">{copy.next[choice.next]}</p>
      <BlockerChoices item={item} hob={hob}>
        {!inChat && item.threadId !== null && (
          <Link
            to="/hobs/$hobId/threads/$threadId"
            params={{ hobId: item.recipientId, threadId: item.threadId }}
            className="ms-auto text-detail"
          >
            {copy.openChat}
          </Link>
        )}
      </BlockerChoices>
    </section>
  );
}
