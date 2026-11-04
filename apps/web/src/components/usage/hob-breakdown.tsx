import { HOB_COLORS } from "@hobbots/art/look";
import { type Agent, type AgentId, RUNTIME_NAMES } from "@hobbots/domain";
import { Badge } from "@hobbots/ui/components/badge";
import { cn } from "@hobbots/ui/lib/utils";
import { formatDay } from "../../lib/format.ts";
import { type BrainShare, busiestDay, type DayUsage, type HobShare } from "../../lib/usage.ts";
import { HobSprite } from "../hob-sprite.tsx";
import { messages } from "./messages.ts";

const copy = messages.hobs;

const brainLabel = (brain: BrainShare) =>
  brain.runtime === null
    ? copy.earlierBrain
    : copy.brain({ runtime: RUNTIME_NAMES[brain.runtime], model: brain.model });

function HobRow({ hob, look, most }: { hob: HobShare; look: Agent | undefined; most: number }) {
  // The hob's own hat color tints its tile and its bar, as everywhere it appears.
  const color = look ? HOB_COLORS[look.lookColor].hat : undefined;
  return (
    <li className="flex flex-col gap-1 px-3 py-2.5 shadow-[inset_0_1px_0_var(--color-line)] first:shadow-none">
      <span className="flex items-center gap-3">
        <span
          aria-hidden="true"
          className="grid size-[30px] shrink-0 place-items-center overflow-hidden rounded-tile bg-tile"
          style={
            color === undefined ? undefined : { background: `color-mix(in srgb, ${color} 30%, var(--color-card))` }
          }
        >
          {look && <HobSprite hob={look} size={22} />}
        </span>
        <span className="flex w-[170px] min-w-0 shrink-0 flex-col">
          <span className="flex items-center gap-2">
            <span className="truncate font-semibold text-text-strong">{hob.name}</span>
            {hob.status === "retired" && <Badge variant="archived">{copy.retired}</Badge>}
          </span>
          <span className="truncate text-meta text-label">{hob.brains.map(brainLabel).join(", ")}</span>
        </span>
        <span className="h-2 min-w-[80px] flex-1 overflow-hidden rounded-dot bg-line-2" aria-hidden="true">
          <span
            className={cn("block h-full rounded-dot", color === undefined && "bg-control")}
            style={{ width: `${most === 0 ? 0 : (hob.share / most) * 100}%`, ...(color && { background: color }) }}
          />
        </span>
        <span
          className="flex w-[132px] shrink-0 flex-col items-end whitespace-nowrap tabular-nums"
          title={copy.tokens({ input: hob.inputTokens, output: hob.outputTokens })}
        >
          <strong className="text-text-strong">{copy.share({ share: hob.share })}</strong>
          <span className="text-meta text-label">{copy.amount({ tokens: hob.tokens, replies: hob.replies })}</span>
        </span>
      </span>
      {hob.unreported > 0 && (
        <span className="ps-[42px] text-meta text-label">{copy.unreported({ count: hob.unreported })}</span>
      )}
    </li>
  );
}

/** Each hob's share of the period's tokens, most first, with the brains it used. The shares add up to 100. */
export function HobBreakdown({
  hobs,
  looks,
  period,
}: {
  hobs: ReadonlyArray<HobShare>;
  looks: ReadonlyMap<AgentId, Agent>;
  period: string;
}) {
  if (hobs.length === 0) return <p className="m-0 text-text-secondary">{copy.empty({ period })}</p>;
  // The longest bar is the hob that used the most, so small shares stay readable.
  const most = Math.max(...hobs.map((hob) => hob.share));
  return (
    <ul className="cut m-0 flex list-none flex-col bg-card p-0">
      {hobs.map((hob) => (
        <HobRow key={hob.hobId} hob={hob} look={looks.get(hob.hobId)} most={most} />
      ))}
    </ul>
  );
}

/** The period's replies on each of the reader's days, today last and lit, with the busiest day named. */
export function DailyChart({ days }: { days: ReadonlyArray<DayUsage> }) {
  const most = Math.max(1, ...days.map((day) => day.replies));
  const first = days[0];
  const busiest = busiestDay(days);
  return (
    <div className="cut flex flex-col bg-card">
      <ol
        className={cn(
          "m-0 flex h-[140px] list-none items-end px-4 pt-4 pb-0",
          "bg-[repeating-linear-gradient(0deg,transparent_0_34px,var(--color-line)_34px_35px)] bg-origin-content",
          days.length > 7 ? "gap-[3px]" : "gap-2.5",
        )}
      >
        {days.map((day, index) => {
          const label = messages.daily.day({
            day: formatDay(`${day.day}T12:00:00`),
            replies: day.replies,
            tokens: day.tokens,
          });
          return (
            <li key={day.day} className="flex h-full flex-1 flex-col justify-end" title={label}>
              <span className="sr-only">{label}</span>
              <span
                aria-hidden="true"
                className={cn(
                  "block min-h-[3px] rounded-t-[4px]",
                  index === days.length - 1 ? "bg-lantern" : "bg-line-2",
                )}
                style={{ height: `${Math.round((day.replies / most) * 100)}%` }}
              />
            </li>
          );
        })}
      </ol>
      <div
        className="flex justify-between gap-3 border-t border-line-2 px-4 py-2 text-meta text-label"
        aria-hidden="true"
      >
        <span>{first && formatDay(`${first.day}T12:00:00`)}</span>
        {busiest && <span>{messages.daily.busiest({ day: formatDay(`${busiest.day}T12:00:00`) })}</span>}
        <span>{messages.daily.today}</span>
      </div>
    </div>
  );
}
