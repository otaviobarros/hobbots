import type { Agent } from "@hobbots/domain";
import { messages } from "./messages.ts";
import { useHobWaiting } from "./use-hob-waiting.ts";
import { WaitingList } from "./waiting-list.tsx";

const copy = messages;

/**
 * A hob's backpack under its row in the hob panel (ADR 019): how many items wait for it, and, for
 * the hob that is open, each item with where it stands, so a member's finished result shows as
 * awaiting its lead until the lead has handled it.
 */
export function HobBackpack({ hob, open }: { hob: Agent; open: boolean }) {
  const { now, view, hobs, openItem, count } = useHobWaiting(hob);
  const shown = open && count + view.handled.length + view.routine > 0;
  if (!shown && count === 0) return null;
  return (
    <section aria-label={copy.hob.label({ name: hob.name })} className="flex flex-col">
      {count > 0 && <span className="py-[3px] ps-[46px] pe-2 text-xs text-lantern">{copy.hob.count({ count })}</span>}
      {shown && (
        <WaitingList
          view={view}
          hobs={hobs}
          now={now}
          owners={false}
          limit={4}
          onOpen={(item) => void openItem(item)}
          label={copy.hob.list}
          className="ps-6"
        />
      )}
    </section>
  );
}
