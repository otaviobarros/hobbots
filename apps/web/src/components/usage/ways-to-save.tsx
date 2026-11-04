import type { AgentId } from "@hobbots/domain";
import { Button } from "@hobbots/ui/components/button";
import { Link } from "@tanstack/react-router";
import type { HobShare } from "../../lib/usage.ts";
import { messages } from "./messages.ts";

const copy = messages.tips;

/** A tip's way to act on it: a hob's profile, or the Inbox. */
type TipAction = { readonly label: string } & (
  | { readonly to: "/hobs/$hobId/profile"; readonly hobId: AgentId }
  | { readonly to: "/inbox" }
);

interface Tip {
  readonly key: string;
  readonly title: string;
  readonly why: string;
  readonly action: TipAction | null;
}

/**
 * What makes a plan last, in plain words. Nothing is estimated: the one tip that names a hob names
 * the one that used the most in the period, from the same numbers as the list above it.
 */
const tipsFor = (busiest: HobShare | undefined): ReadonlyArray<Tip> => [
  ...(busiest !== undefined && busiest.status !== "retired" && busiest.share > 0
    ? [
        {
          key: "busiest",
          title: copy.busiest({ name: busiest.name, share: busiest.share }),
          why: copy.busiestWhy,
          action: {
            label: copy.busiestAct({ name: busiest.name }),
            to: "/hobs/$hobId/profile",
            hobId: busiest.hobId,
          } as const,
        },
      ]
    : []),
  { key: "answer", title: copy.answer, why: copy.answerWhy, action: { label: copy.answerAct, to: "/inbox" } as const },
  { key: "fresh", title: copy.fresh, why: copy.freshWhy, action: null },
];

function TipLink({ action }: { action: TipAction }) {
  return (
    <Button asChild variant="ghost" size="xs">
      {action.to === "/inbox" ? (
        <Link to="/inbox">{action.label}</Link>
      ) : (
        <Link to="/hobs/$hobId/profile" params={{ hobId: action.hobId }}>
          {action.label}
        </Link>
      )}
    </Button>
  );
}

/** A light bulb, the tips' mark. */
function TipIcon() {
  return (
    <span aria-hidden className="grid size-8 shrink-0 place-items-center rounded-tile bg-line text-text-secondary">
      <svg
        aria-hidden="true"
        viewBox="0 0 16 16"
        width={16}
        height={16}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M6 12.5h4M6.5 14.5h3M8 1.5a4.5 4.5 0 0 0-2.6 8.2c.4.3.6.7.6 1.1v.2h4v-.2c0-.4.2-.8.6-1.1A4.5 4.5 0 0 0 8 1.5z" />
      </svg>
    </span>
  );
}

/** Ways to make the plan last, each with what to do about it. How to save on the banner leads here. */
export function WaysToSave({ busiest }: { busiest: HobShare | undefined }) {
  return (
    <ul className="cut m-0 flex list-none flex-col bg-card p-0">
      {tipsFor(busiest).map((tip) => (
        <li
          key={tip.key}
          className="flex flex-wrap items-center gap-3 px-3.5 py-3 shadow-[inset_0_1px_0_var(--color-line)] first:shadow-none"
        >
          <TipIcon />
          <span className="flex min-w-0 flex-1 basis-[240px] flex-col">
            <span className="text-ui text-text-strong">{tip.title}</span>
            <span className="text-meta text-label">{tip.why}</span>
          </span>
          {tip.action !== null && <TipLink action={tip.action} />}
        </li>
      ))}
    </ul>
  );
}
