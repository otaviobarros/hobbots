import { HOB_COLORS } from "@hobbots/art/look";
import { type Agent, type AgentId, RUNTIME_NAMES } from "@hobbots/domain";
import { cn } from "@hobbots/ui/lib/utils";
import { formatDay } from "../../lib/format.ts";
import type { BrainShare, DayUsage, HobShare } from "../../lib/usage.ts";
import { HobSprite } from "../hob-sprite.tsx";
import { messages } from "./messages.ts";

const copy = messages.hobs;

const brainLabel = (brain: BrainShare) =>
  brain.runtime === null
    ? copy.earlierBrain
    : copy.brain({ runtime: RUNTIME_NAMES[brain.runtime], model: brain.model });

function HobRow({ hob, look }: { hob: HobShare; look: Agent | undefined }) {
  const color = look ? HOB_COLORS[look.lookColor].hat : undefined;
  return (
    <li className="flex flex-wrap items-center gap-x-3.5 gap-y-1">
      <span className="w-8 shrink-0" aria-hidden="true">
        {look && <HobSprite hob={look} size={32} />}
      </span>
      <span className="flex w-[180px] min-w-0 flex-col">
        <span className="flex items-center gap-2">
          <span className="truncate font-pixel text-base font-semibold">{hob.name}</span>
          {hob.status === "retired" && (
            <span className="border-2 border-line-2 px-1 text-[11px] text-label">{copy.retired}</span>
          )}
        </span>
        <span className="truncate text-xs text-label">{hob.brains.map(brainLabel).join(", ")}</span>
      </span>
      <span className="h-3.5 min-w-[120px] flex-1 bg-line" aria-hidden="true">
        <span
          className={cn("block h-full", color === undefined && "bg-control")}
          style={{ width: `${hob.share}%`, ...(color && { background: color }) }}
        />
      </span>
      <span
        className="flex w-[190px] flex-col items-end text-sm text-secondary-text tabular-nums"
        title={copy.tokens({ input: hob.inputTokens, output: hob.outputTokens })}
      >
        <span>{copy.share({ share: hob.share, tokens: hob.tokens })}</span>
        <span className="text-xs text-label">{copy.replies({ count: hob.replies })}</span>
      </span>
      {hob.unreported > 0 && (
        <span className="basis-full ps-[46px] text-xs text-label">{copy.unreported({ count: hob.unreported })}</span>
      )}
    </li>
  );
}

/** Each hob's share of the period's tokens, most first, with the brains it used. */
export function HobBreakdown({
  hobs,
  looks,
  period,
}: {
  hobs: ReadonlyArray<HobShare>;
  looks: ReadonlyMap<AgentId, Agent>;
  period: string;
}) {
  if (hobs.length === 0) return <p className="m-0 text-secondary-text">{copy.empty({ period })}</p>;
  return (
    <ul className="m-0 flex list-none flex-col gap-3.5 p-0">
      {hobs.map((hob) => (
        <HobRow key={hob.hobId} hob={hob} look={looks.get(hob.hobId)} />
      ))}
    </ul>
  );
}

/** The period's replies on each of the reader's days, today last and lit. */
export function DailyChart({ days }: { days: ReadonlyArray<DayUsage> }) {
  const most = Math.max(1, ...days.map((day) => day.replies));
  const first = days[0];
  return (
    <>
      <ol
        className={cn(
          "m-0 flex h-40 list-none items-end border-b-2 border-line-2 p-0",
          days.length > 7 ? "gap-1" : "gap-3.5",
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
                className={cn("block", index === days.length - 1 ? "bg-lantern" : "bg-mint")}
                style={{ height: `${Math.round((day.replies / most) * 100)}%` }}
              />
            </li>
          );
        })}
      </ol>
      <div className="flex justify-between text-xs text-label" aria-hidden="true">
        <span>{first && formatDay(`${first.day}T12:00:00`)}</span>
        <span>{messages.daily.today}</span>
      </div>
    </>
  );
}
