import type { FileChangeKind } from "@hobbots/domain";
import { cn } from "@hobbots/ui/lib/utils";
import { messages } from "./messages.ts";

const tone: Record<FileChangeKind, string> = {
  added: "bg-mint text-ground",
  edited: "bg-line-2 text-text-strong",
  deleted: "bg-rose text-ground",
  moved: "bg-lantern text-ground",
  link: "bg-line text-text-secondary",
};

/** How a file changed: Added, Edited, Deleted, Moved or Link, one color each. */
export function KindTag({ kind }: { kind: FileChangeKind }) {
  return (
    <span className={cn("shrink-0 px-1.5 py-px text-xs font-bold whitespace-nowrap", tone[kind])}>
      {messages.kind[kind]}
    </span>
  );
}
