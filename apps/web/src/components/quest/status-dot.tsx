import { cn } from "@hobbots/ui/lib/utils";
import type { RowStatus } from "./work-model.ts";

const tone: Record<RowStatus, string> = {
  "needs-you": "bg-lantern animate-hb-blink",
  failed: "bg-rose",
  blocked: "bg-rose",
  running: "bg-mint animate-hb-blink",
  waiting: "bg-label",
  done: "bg-mint-deep",
};

const tag: Record<RowStatus, string> = {
  "needs-you": "bg-lantern text-ground",
  failed: "bg-rose text-ground",
  blocked: "bg-rose text-ground",
  running: "bg-line text-mint",
  waiting: "bg-line text-secondary-text",
  done: "bg-line text-mint",
};

/** A square that says where work stands at a glance; its words are always beside it. */
export function StatusDot({ status, className }: { status: RowStatus; className?: string }) {
  return <span aria-hidden className={cn("size-2 shrink-0", tone[status], className)} />;
}

/** Where work stands, in words. */
export function StatusTag({ status, children }: { status: RowStatus; children: string }) {
  return <span className={cn("px-tag-x py-0.5 text-xs font-bold whitespace-nowrap", tag[status])}>{children}</span>;
}
