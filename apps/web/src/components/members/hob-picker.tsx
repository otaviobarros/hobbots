import type { Agent, AgentId, User } from "@hobbots/domain";
import { cn } from "@hobbots/ui/lib/utils";
import { HobTile } from "../hob-sprite/hob-sprite.tsx";
import { PersonBadge } from "../sidebar/sidebar-faces.tsx";
import { messages } from "./messages.ts";

const copy = messages.picker;

/** A hob's line under its name in a picker: its role, if it has one. */
export const hobRoleLine = (hob: Agent): string => (hob.roleTitle.trim() === "" ? copy.noRole : hob.roleTitle);

/**
 * Who a camp is made with (ADR 039, Members; Screens › GroupChatNew): you, then a chip for each hob
 * picked, in the order picked, and below them every hob that takes new work, each a checkbox. The
 * first picked leads the camp's quests. `locked` stays picked, as the hob whose chapter moves in.
 */
export function HobPicker({
  you,
  hobs,
  picked,
  locked,
  labelledBy,
  describedBy,
  onToggle,
}: {
  you: User | undefined;
  hobs: ReadonlyArray<Agent>;
  picked: ReadonlyArray<AgentId>;
  locked: AgentId | null;
  /** The id of the field's label, which names the list. */
  labelledBy: string;
  describedBy: string;
  onToggle: (hob: AgentId) => void;
}) {
  const chosen = picked.flatMap((id) => hobs.filter((hob) => hob.id === id));
  return (
    <>
      <ul aria-label={copy.chosen} className="m-0 flex list-none flex-wrap gap-1.5 p-0">
        <li className={chip}>
          {you !== undefined && (
            <span aria-hidden className="contents">
              <PersonBadge person={you} size="sm" />
            </span>
          )}
          {copy.you}
        </li>
        {chosen.map((hob, index) => (
          <li key={hob.id} className={chip}>
            <HobTile hob={hob} tile="sm" />
            {index === 0 ? copy.leads({ name: hob.name }) : hob.name}
          </li>
        ))}
      </ul>
      <fieldset
        aria-labelledby={labelledBy}
        aria-describedby={describedBy}
        className="m-0 flex max-h-[200px] min-w-0 flex-col gap-px overflow-auto rounded-control bg-card p-1 border-(length:--edge) border-line"
      >
        <legend className="sr-only">{copy.label}</legend>
        <span aria-hidden className="px-2 pt-1.5 pb-0.5 text-meta font-bold text-label">
          {copy.hobs}
        </span>
        {hobs.map((hob) => (
          <HobCheck
            key={hob.id}
            hob={hob}
            checked={picked.includes(hob.id)}
            locked={hob.id === locked}
            onToggle={() => onToggle(hob.id)}
          />
        ))}
      </fieldset>
    </>
  );
}

const chip =
  "inline-flex h-[30px] items-center gap-1.5 rounded-full bg-card ps-1 pe-2.5 text-detail font-semibold text-text-strong border-(length:--edge) border-line-2";

/** One hob in the picker: its tile, name and role, and whether it is picked. */
function HobCheck({
  hob,
  checked,
  locked,
  onToggle,
}: {
  hob: Agent;
  checked: boolean;
  locked: boolean;
  onToggle: () => void;
}) {
  return (
    <label
      className={cn(
        "grid w-full grid-cols-[28px_minmax(0,1fr)_auto] items-center gap-2.5 rounded-control px-2 py-1.5 text-ui text-text-strong",
        "has-focus-visible:outline-2 has-focus-visible:outline-focus-ring",
        locked ? "cursor-default" : "cursor-pointer hover:bg-hover",
      )}
    >
      <input type="checkbox" className="sr-only" checked={checked} disabled={locked} onChange={onToggle} />
      <HobTile hob={hob} tile="md" />
      <span className="flex min-w-0 flex-col">
        <b className="truncate font-semibold">{hob.name}</b>
        <small className="truncate text-meta text-label">{locked ? copy.lockedLine : hobRoleLine(hob)}</small>
      </span>
      <CheckBox checked={checked} />
    </label>
  );
}

/** The picker's tick: decorative, since the row is the checkbox. */
export function CheckBox({ checked }: { checked: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        "inline-flex size-[18px] items-center justify-center rounded-[calc(var(--corner-control)*3/8)] border-(length:--edge) text-meta font-bold",
        checked ? "border-focus-ring bg-focus-ring text-ground" : "border-control",
      )}
    >
      {checked ? copy.tick : ""}
    </span>
  );
}
