import type { MessageId } from "@hobbots/domain";
import { cn } from "@hobbots/ui/lib/utils";
import type { ThreadLine as Line } from "../../lib/reply-threads.ts";
import { formatTime } from "../../lib/time.ts";
import { FaceTile } from "../sidebar/sidebar-faces.tsx";
import { messages as copy } from "./messages.ts";
import { type Cast, whoIs } from "./thread-faces.ts";

/** How many repliers' faces the line stacks. */
const FACES = 3;

/**
 * A root's thread in one line (ADR 039, Reply threads): the faces of who replied, the count and the
 * time of the last reply. It opens the thread beside the chat, and reads as pressed while it is open.
 */
export function ThreadLine({
  rootId,
  line,
  cast,
  open,
  onOpen,
  end = false,
}: {
  rootId: MessageId;
  line: Line;
  cast: Cast;
  open: boolean;
  onOpen: (rootId: MessageId) => void;
  /** Under your own message, which sits at the end of the line. */
  end?: boolean;
}) {
  const faces = line.repliers.slice(0, FACES).flatMap((actor) => {
    const face = whoIs(cast, actor).face;
    return face === null ? [] : [face];
  });
  return (
    <button
      type="button"
      aria-pressed={open}
      onClick={() => onOpen(rootId)}
      className={cn(
        "group/thread flex h-[34px] cursor-pointer items-center gap-2.5 rounded-control border-0 bg-transparent ps-1.5 pe-3 text-ui text-text-secondary hover:bg-card hover:shadow-[inset_0_0_0_1px_var(--color-line-2)] aria-pressed:bg-card aria-pressed:shadow-[inset_0_0_0_1px_var(--color-line-2)]",
        end ? "self-end" : "ms-10 self-start",
      )}
    >
      {faces.length > 0 && (
        <span aria-hidden className="flex *:rounded-tile *:shadow-[0_0_0_2px_var(--color-ground)] *:not-first:-ms-1">
          {faces.map((face) => (
            <span key={face._tag === "hob" ? face.hob.id : face.person.id} className="inline-flex">
              <FaceTile face={face} size="sm" />
            </span>
          ))}
        </span>
      )}
      <b className="font-semibold text-link">{copy.replies({ count: line.count })}</b>
      <span className="text-label">{copy.lastReply({ time: formatTime(line.lastAt) })}</span>
      <span className="text-label opacity-0 group-hover/thread:opacity-100 group-aria-pressed/thread:opacity-100">
        {copy.view}
      </span>
    </button>
  );
}
