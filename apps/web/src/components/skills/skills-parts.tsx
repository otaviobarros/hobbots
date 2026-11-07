import type { Agent, SkillScope } from "@hobbots/domain";
import { cn } from "@hobbots/ui/lib/utils";
import { HobTile } from "../hob-sprite/hob-sprite.tsx";
import { LineIcon } from "../shell/line-icon.tsx";

/** A revision as a small mono tag, such as r4; `old` greys out one that is not the newest. */
export function RevTag({ label, old = false }: { label: string; old?: boolean }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-tag px-[7px] py-px font-mono text-meta font-semibold whitespace-nowrap",
        old
          ? "bg-line text-text-secondary"
          : "bg-[color-mix(in_srgb,var(--color-mint)_16%,transparent)] text-text-strong",
      )}
    >
      {label}
    </span>
  );
}

const SCOPE_DOT = { Everyone: "bg-star", Project: "bg-mint", Hob: "bg-lantern", None: "bg-label" } as const;

/** A scope as a tag with its colored dot: star for Everyone, mint for a project, lantern for a hob. */
export function ScopeTag({ scope, label }: { scope: SkillScope | null; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-tag bg-line px-2 py-0.5 text-meta font-semibold whitespace-nowrap text-text-secondary">
      <span aria-hidden className={cn("size-[7px] rounded-dot", SCOPE_DOT[scope?._tag ?? "None"])} />
      {label}
    </span>
  );
}

/** A small state tag beside a skill's name. */
export function SkillChip({ tone, children }: { tone: "later" | "waiting" | "needs"; children: React.ReactNode }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-tag px-2 py-0.5 text-meta font-semibold whitespace-nowrap",
        tone === "later" && "bg-line text-text-secondary",
        tone === "waiting" && "bg-[color-mix(in_srgb,var(--color-star)_18%,transparent)] text-text-strong",
        tone === "needs" && "bg-[color-mix(in_srgb,var(--color-lantern)_18%,transparent)] text-text-strong",
      )}
    >
      {children}
    </span>
  );
}

/** Line icons on a 16 × 16 grid, in the color of the text beside them. */
const ICONS = {
  overview: "M2.5 2.5h4.5v4.5H2.5zM9 2.5h4.5v4.5H9zM2.5 9h4.5v4.5H2.5zM9 9h4.5v4.5H9z",
  review: "M2.5 3.5h11v7h-4l-1.5 2-1.5-2h-4zM5.5 7h5",
  changes: "M8 2.5a5.5 5.5 0 1 1-5.2 3.7M2.5 2.5v3.7h3.7M8 5v3l2 1.5",
  everyone:
    "M5.5 7a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM11 7a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM1.5 13c0-2.2 1.8-3.5 4-3.5s4 1.3 4 3.5M9.5 9.6c.5-.1 1-.1 1.5-.1 2.2 0 3.5 1.3 3.5 3.5",
  project: "M2 4.5V12.5h12V6H8L6.5 4.5z",
  notice: "M8 2a6 6 0 1 0 0 12A6 6 0 0 0 8 2zM8 5v3.5M8 11v.1",
  flag: "M8 2.5 14 13H2zM8 6.5v3M8 11.3v.1",
  git: "M5 3.5a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3zM5 9.5a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3zM11 5.5a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3zM5 6.5v3M11 8.5c0 2-3 2-6 2.5",
  file: "M8 10.5V3M5 5.5 8 2.5l3 3M3 10.5v2a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1v-2",
  write: "M3 13l1-3.5L11 2.5l2.5 2.5-7 7zM9.5 4l2.5 2.5",
  lock: "M5 7h6a1.5 1.5 0 0 1 1.5 1.5V12A1.5 1.5 0 0 1 11 13.5H5A1.5 1.5 0 0 1 3.5 12V8.5A1.5 1.5 0 0 1 5 7zM5.5 7V5a2.5 2.5 0 0 1 5 0v2",
} as const;

export type SkillsIconName = keyof typeof ICONS;

export function SkillsIcon({ name, size = 16 }: { name: SkillsIconName; size?: number }) {
  return <LineIcon path={ICONS[name]} size={size} />;
}

/** Who a scope belongs to, as a row shows it: the hob on its tile, or a group or folder icon. */
export function ScopeMark({ scope, hob }: { scope: SkillScope; hob: Agent | undefined }) {
  if (hob !== undefined) return <HobTile hob={hob} tile="sm" />;
  return (
    <span
      aria-hidden
      className="flex size-6 shrink-0 items-center justify-center rounded-tile bg-line text-text-secondary"
    >
      <SkillsIcon name={scope._tag === "Project" ? "project" : "everyone"} size={14} />
    </span>
  );
}
