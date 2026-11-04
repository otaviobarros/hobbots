import type { FileChangeKind } from "@hobbots/domain";
import { cn } from "@hobbots/ui/lib/utils";
import { messages } from "./messages.ts";

// Tinted pills: the kind's color on a light wash of itself, so the list stays quiet beside the diff.
const tone: Record<FileChangeKind, string> = {
  added: "bg-mint/22 text-mint",
  edited: "bg-line text-text-secondary",
  deleted: "bg-rose/22 text-rose",
  moved: "bg-lantern/22 text-lantern",
  link: "bg-line text-text-secondary",
};

/** How a file changed: Added, Edited, Deleted, Moved or Link, one color each. */
export function KindTag({ kind }: { kind: FileChangeKind }) {
  return (
    <span className={cn("shrink-0 rounded-tag px-1.5 py-px text-meta font-bold whitespace-nowrap", tone[kind])}>
      {messages.kind[kind]}
    </span>
  );
}
