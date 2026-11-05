import type { Agent, MemoryKind, MemoryScope } from "@hobbots/domain";
import { Button } from "@hobbots/ui/components/button";
import { cn } from "@hobbots/ui/lib/utils";
import { HobTile } from "../hob-sprite/hob-sprite.tsx";
import { messages } from "./messages.ts";

const copy = messages;

/** A page's kind as a small tag. */
export function KindTag({ kind }: { kind: MemoryKind }) {
  return (
    <span className="inline-flex items-center rounded-tag bg-line px-2 py-0.5 text-meta font-semibold whitespace-nowrap text-text-secondary">
      {copy.kinds[kind].one}
    </span>
  );
}

/** The Pinned tag beside a page's title. */
export function PinnedTag() {
  return (
    <span className="inline-flex items-center rounded-tag bg-line px-[7px] py-0.5 text-meta font-semibold text-label">
      {copy.pinned}
    </span>
  );
}

/** Line icons on a 16 × 16 grid, in the color of the text beside them. */
const ICONS = {
  overview: "M2.5 2.5h4.5v4.5H2.5zM9 2.5h4.5v4.5H9zM2.5 9h4.5v4.5H2.5zM9 9h4.5v4.5H9z",
  changes: "M8 2a6 6 0 1 0 0 12A6 6 0 0 0 8 2zM8 4.5V8l2.5 1.5",
  review: "M2.5 8.5 6 12l7.5-8",
  about: "M8 7.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5zM3 13.5c0-2.8 2.2-4.5 5-4.5s5 1.7 5 4.5",
  project: "M2 4.5V12.5h12V6H8L6.5 4.5z",
  notice: "M8 2a6 6 0 1 0 0 12A6 6 0 0 0 8 2zM8 5v3.5M8 11v.1",
} as const;

export type MemoryIconName = keyof typeof ICONS;

export function MemoryIcon({ name, size = 16 }: { name: MemoryIconName; size?: number }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      className="shrink-0"
    >
      <path d={ICONS[name]} />
    </svg>
  );
}

/** Who a scope belongs to, as a row shows it: the hob on its tile, or a folder or person icon. */
export function ScopeMark({
  scope,
  hob,
  size = "sm",
}: {
  scope: MemoryScope;
  hob: Agent | undefined;
  size?: "sm" | "lg";
}) {
  if (hob !== undefined) return <HobTile hob={hob} tile={size === "lg" ? "lg" : "sm"} />;
  return (
    <span
      aria-hidden
      className={cn(
        "flex shrink-0 items-center justify-center rounded-tile bg-line text-text-secondary",
        size === "lg" ? "size-11" : "size-6",
      )}
    >
      <MemoryIcon name={scope._tag === "Project" ? "project" : "about"} size={size === "lg" ? 22 : 14} />
    </span>
  );
}

/** A card of the page, as the design's side cards and peeks. */
export function MemoryCard({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <section aria-label={label} className="flex flex-col gap-2.5 rounded-card bg-card p-4">
      {children}
    </section>
  );
}

/** A small label over a group, with what follows it on the same line. */
export function GroupLabel({ children }: { children: React.ReactNode }) {
  return <div className="flex min-h-6 flex-wrap items-center gap-2">{children}</div>;
}

/** A read that failed for a reason other than memory not answering: what failed, and Try again. */
export function ReadFailed({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div role="alert" className="flex flex-wrap items-center gap-3 text-ui text-text-secondary">
      <span>{message}</span>
      <Button variant="outline" size="sm" onClick={onRetry}>
        {copy.retry}
      </Button>
    </div>
  );
}
