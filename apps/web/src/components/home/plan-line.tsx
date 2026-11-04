import { cn } from "@hobbots/ui/lib/utils";
import { Link } from "@tanstack/react-router";
import type { PlanLevel } from "../../lib/usage.ts";
import { planOf, planSummary, usePlans } from "../usage/plan-summary.ts";
import { messages } from "./messages.ts";

const copy = messages.plan;

const barTone: Record<PlanLevel, string> = { ok: "bg-mint", low: "bg-lantern", out: "bg-rose" };

/**
 * One line at the foot of Home on what is left of the Claude Code plan, in the Usage screen's own
 * numbers and words, with a bar of what is left. It opens Usage.
 */
export function PlanLine() {
  // The same plan, and the same words, as the Usage screen.
  const summary = planSummary(planOf(usePlans(), "claude-code"), new Date());
  return (
    <Link
      to="/usage"
      className="flex items-center gap-3.5 rounded-card bg-card py-3 ps-3 pe-3.5 text-inherit no-underline transition-colors hover:bg-hover"
    >
      <span
        aria-hidden
        className="flex size-8 shrink-0 items-center justify-center rounded-tile bg-[color-mix(in_srgb,var(--color-mint)_16%,transparent)] text-mint"
      >
        <svg aria-hidden viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.5">
          <path
            d="M8 2v3M8 11v3M2 8h3M11 8h3M4 4l1.8 1.8M10.2 10.2 12 12M4 12l1.8-1.8M10.2 5.8 12 4"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-1.5">
        <span className="flex flex-wrap items-baseline gap-x-2">
          <span className="font-semibold text-text-strong">{copy.title}</span>
          <span className="text-[13px] text-text-secondary">{summary?.line ?? copy.notReported}</span>
        </span>
        {summary !== null && (
          <span aria-hidden className="block h-1.5 overflow-hidden rounded-dot bg-line-2">
            <span
              className={cn("block h-full rounded-dot", barTone[summary.level])}
              style={{ width: `${Math.round(summary.left * 100)}%` }}
            />
          </span>
        )}
      </span>
      <span className="inline-flex items-center gap-1 px-2 text-[13px] text-link">
        {copy.usage}
        <span aria-hidden>→</span>
      </span>
    </Link>
  );
}
