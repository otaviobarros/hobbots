import type { Agent } from "@hobbots/domain";
import { cn } from "@hobbots/ui/lib/utils";
import type { ReactNode } from "react";
import { HobSprite } from "../hob-sprite/hob-sprite.tsx";
import { messages } from "./messages.ts";

/** The tables of Usage › Searches and pages (ADR 036). */

const copy = messages.usage;

/** A hob's tile, or a plain square for a hob no longer listed. */
function Tile({ look }: { look: Agent | undefined }) {
  return look === undefined ? (
    <span aria-hidden className="size-7 flex-none rounded-tile bg-line-2" />
  ) : (
    <HobSprite hob={look} size={28} />
  );
}

/** A row's first cell: the hob's tile, then a title over a line. */
export function WhoCell({ look, title, sub }: { look: Agent | undefined; title: ReactNode; sub: string }) {
  return (
    <td className="px-3 py-2.5">
      <span className="flex items-center gap-2.5">
        <Tile look={look} />
        <span className="flex min-w-0 flex-col">
          {title}
          <span className="text-meta text-label">{sub}</span>
        </span>
      </span>
    </td>
  );
}

/** A hob's searches as a bar against the hob that searched the most, then the count. */
export function SearchesBar({ searches, most }: { searches: number; most: number }) {
  return (
    <td className="w-[40%] px-3 py-2.5">
      <span className="flex items-center gap-3">
        <span aria-hidden className="h-2 min-w-[60px] flex-1 overflow-hidden rounded-dot bg-line-2">
          <span className="block h-full rounded-dot bg-moonlight" style={{ width: `${(searches / most) * 100}%` }} />
        </span>
        <span className="w-8 text-end font-mono font-bold text-text-strong tabular-nums">{searches}</span>
      </span>
    </td>
  );
}

const headClass = "px-3 py-2 text-start text-meta font-normal text-label";

/** By hob's and Busiest turns' table: its head, then the rows it is given. */
export function UsageTable({
  first,
  searchesEnd,
  children,
}: {
  first: string;
  /** Whether the searches column is a number at its end rather than a bar. */
  searchesEnd: boolean;
  children: ReactNode;
}) {
  return (
    <div className="overflow-x-auto rounded-card bg-card">
      <table className="w-full border-collapse text-ui">
        <thead>
          <tr>
            <th className={headClass}>{first}</th>
            <th className={cn(headClass, searchesEnd && "text-end")}>{copy.columns.searches}</th>
            <th className={cn(headClass, "text-end")}>{copy.columns.pages}</th>
            <th className={headClass}>{copy.columns.limits}</th>
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}
