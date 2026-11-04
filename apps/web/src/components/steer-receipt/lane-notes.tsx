import type { AgentId, TaskTree, ThreadId } from "@hobbots/domain";
import { cn } from "@hobbots/ui/lib/utils";
import { useQuery } from "@tanstack/react-query";
import { messagesQuery } from "../../api/queries.ts";
import { firstLine } from "../../lib/format.ts";
import { HobSprite } from "../hob-sprite/hob-sprite.tsx";
import type { HobLookup } from "../quest/use-work.ts";
import { messages } from "./messages.ts";
import { laneNoteChips, type NoteChip } from "./steer-model.ts";

/** Your note is dashed in lantern; the lead passing it on looks like any hand-off. */
const yoursChip =
  "border-(length:--edge) border-dashed border-lantern bg-[color-mix(in_srgb,var(--color-lantern)_14%,var(--color-card))]";
const handChip = "bg-[color-mix(in_srgb,var(--color-star)_16%,var(--color-card))]";

/** The arrow, the hob whose sprite the chip wears, the words and how the chip looks. */
const chipParts = (chip: NoteChip, owner: AgentId, hobs: HobLookup) => {
  if (chip._tag === "yours")
    return {
      arrow: "✎",
      hob: owner,
      // A long message shows its first line; the whole of it is the chip's tooltip.
      text: messages.chip.yours({ text: firstLine(chip.text) }),
      look: yoursChip,
      tone: "text-lantern",
      title: chip.text,
    };
  if (chip._tag === "via")
    return {
      arrow: "←",
      hob: chip.from,
      text: messages.chip.via({ name: hobs(chip.from).name }),
      look: yoursChip,
      tone: "text-lantern",
      title: chip.text,
    };
  const names = chip.to.map((id) => hobs(id).name);
  return {
    arrow: "→",
    hob: chip.to[0] ?? owner,
    text: messages.chip.passed({ names }),
    look: handChip,
    tone: "text-star",
  };
};

function Chip({ chip, owner, hobs }: { chip: NoteChip; owner: AgentId; hobs: HobLookup }) {
  const { arrow, hob, text, look, tone, title } = { title: undefined, ...chipParts(chip, owner, hobs) };
  return (
    <li
      title={title}
      className={cn(
        "flex max-w-full items-center gap-1.5 self-start rounded-dot py-0.75 ps-1 pe-2 text-detail text-text-strong",
        look,
      )}
    >
      <HobSprite hob={hobs(hob)} size={14} />
      <span aria-hidden className={cn("font-bold", tone)}>
        {arrow}
      </span>
      <span className="truncate">{text}</span>
    </li>
  );
}

/**
 * Your notes in a hob's lane (ADR 027): in the lead's, each message you sent while the work ran,
 * dashed, and whom the lead passed it to; in each lane a note reached, "← Your note, via Aldric".
 * Built from the hub's records and your messages in the work's thread, never from what a hob says.
 */
export function LaneNotes({ tree, ownerId, hobs }: { tree: TaskTree; ownerId: AgentId; hobs: HobLookup }) {
  const threadId = tree.tasks[0]?.threadId ?? null;
  const transcript =
    useQuery({ ...messagesQuery(threadId ?? ("" as ThreadId)), enabled: threadId !== null }).data ?? [];
  const chips = laneNoteChips(tree, transcript).get(ownerId) ?? [];
  if (chips.length === 0) return null;
  return (
    <ul aria-label={messages.notes} className="m-0 flex list-none flex-col gap-1.5 p-0">
      {chips.map((chip) => (
        <Chip key={chip.key} chip={chip} owner={ownerId} hobs={hobs} />
      ))}
    </ul>
  );
}
