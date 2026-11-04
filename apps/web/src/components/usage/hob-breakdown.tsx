import { HOB_COLORS } from "@hobbots/art/look";
import { type Agent, type AgentId, RUNTIME_NAMES } from "@hobbots/domain";
import { Badge } from "@hobbots/ui/components/badge";
import { cn } from "@hobbots/ui/lib/utils";
import { formatDay, formatMonthDay, formatWeekday } from "../../lib/format.ts";
import { type BrainShare, busiestDay, type DayUsage, type HobShare, type QuestShare } from "../../lib/usage.ts";
import { HobSprite } from "../hob-sprite/hob-sprite.tsx";
import { messages } from "./messages.ts";

const copy = messages.hobs;
const questCopy = messages.quests;

const brainLabel = (brain: BrainShare) =>
  brain.runtime === null
    ? copy.earlierBrain
    : copy.brain({ runtime: RUNTIME_NAMES[brain.runtime], model: brain.model });

/** One row of Who used what: a tile, a name over one line, a bar scaled to the top row, and the share. */
function ShareRow({
  tile,
  tint,
  name,
  badge,
  sub,
  width,
  share,
  amount,
  detail,
  unreported,
}: {
  tile: React.ReactNode;
  /** The bar's color, or undefined for the neutral control fill. */
  tint: string | undefined;
  name: string;
  badge?: React.ReactNode;
  sub: string;
  /** The bar's length, 0 to 100, against the row that used the most. */
  width: number;
  share: number;
  amount: string;
  /** What the amount is made of, on hover. */
  detail?: string;
  unreported: number;
}) {
  return (
    <li className="flex flex-col gap-1 px-3 py-2.5 shadow-[inset_0_1px_0_var(--color-line)] first:shadow-none">
      <span className="flex items-center gap-3">
        {tile}
        <span className="flex w-[170px] min-w-0 shrink-0 flex-col">
          <span className="flex items-center gap-2">
            <span className="truncate font-semibold text-text-strong">{name}</span>
            {badge}
          </span>
          <span className="truncate text-meta text-label">{sub}</span>
        </span>
        <span className="h-2 min-w-[80px] flex-1 overflow-hidden rounded-dot bg-line-2" aria-hidden="true">
          <span
            className={cn("block h-full rounded-dot", tint === undefined && "bg-control")}
            style={{ width: `${width}%`, ...(tint && { background: tint }) }}
          />
        </span>
        <span className="flex w-[132px] shrink-0 flex-col items-end whitespace-nowrap tabular-nums" title={detail}>
          <strong className="text-text-strong">{copy.share({ share })}</strong>
          <span className="text-meta text-label">{amount}</span>
        </span>
      </span>
      {unreported > 0 && (
        <span className="ps-[42px] text-meta text-label">{copy.unreported({ count: unreported })}</span>
      )}
    </li>
  );
}

const scaled = (share: number, most: number) => (most === 0 ? 0 : (share / most) * 100);

function HobRow({ hob, look, most }: { hob: HobShare; look: Agent | undefined; most: number }) {
  // The hob's own hat color tints its tile and its bar, as everywhere it appears.
  const color = look ? HOB_COLORS[look.lookColor].hat : undefined;
  return (
    <ShareRow
      tile={
        <span
          aria-hidden="true"
          className="grid size-[30px] shrink-0 place-items-center overflow-hidden rounded-tile bg-tile"
          style={
            color === undefined ? undefined : { background: `color-mix(in srgb, ${color} 30%, var(--color-card))` }
          }
        >
          {look && <HobSprite hob={look} size={22} />}
        </span>
      }
      tint={color}
      name={hob.name}
      badge={hob.status === "retired" && <Badge variant="archived">{copy.retired}</Badge>}
      sub={hob.brains.map(brainLabel).join(", ")}
      width={scaled(hob.share, most)}
      share={hob.share}
      amount={copy.amount({ tokens: hob.tokens, replies: hob.replies })}
      detail={copy.tokens({ input: hob.inputTokens, output: hob.outputTokens })}
      unreported={hob.unreported}
    />
  );
}

/** A quest's flag, on a tile tinted with `star`; the chats outside a quest get a speech bubble. */
function QuestTile({ quest }: { quest: boolean }) {
  return (
    <span
      aria-hidden="true"
      className="grid size-[30px] shrink-0 place-items-center rounded-tile bg-[color-mix(in_srgb,var(--color-star)_18%,var(--color-card))] text-star"
    >
      <svg
        aria-hidden="true"
        viewBox="0 0 16 16"
        width={14}
        height={14}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d={quest ? "M4 14V2.5M4 3h8l-2 3 2 3H4" : "M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z"} />
      </svg>
    </span>
  );
}

function QuestRow({ quest, most }: { quest: QuestShare; most: number }) {
  const inQuest = quest.questId !== null;
  return (
    <ShareRow
      tile={<QuestTile quest={inQuest} />}
      tint={inQuest ? "var(--color-star)" : undefined}
      name={quest.goal ?? questCopy.outside}
      sub={
        inQuest && quest.leadName !== null
          ? questCopy.lead({ lead: quest.leadName, party: quest.party })
          : questCopy.chats({ chats: quest.chats })
      }
      width={scaled(quest.share, most)}
      share={quest.share}
      amount={copy.amount({ tokens: quest.tokens, replies: quest.replies })}
      unreported={quest.unreported}
    />
  );
}

/** Each quest's share of the period's tokens, most first, then the chats outside a quest. */
export function QuestBreakdown({ quests, period }: { quests: ReadonlyArray<QuestShare>; period: string }) {
  if (quests.length === 0) return <p className="m-0 text-text-secondary">{copy.empty({ period })}</p>;
  const most = Math.max(...quests.map((quest) => quest.share));
  return (
    <ul className="cut m-0 flex list-none flex-col bg-card p-0">
      {quests.map((quest) => (
        <QuestRow key={quest.questId ?? ""} quest={quest} most={most} />
      ))}
    </ul>
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
  // The longest bar is the row that used the most, so small shares stay readable.
  const most = Math.max(...hobs.map((hob) => hob.share));
  return (
    <ul className="cut m-0 flex list-none flex-col bg-card p-0">
      {hobs.map((hob) => (
        <HobRow key={hob.hobId} hob={hob} look={looks.get(hob.hobId)} most={most} />
      ))}
    </ul>
  );
}

// A week's days go by their names, a month's by their dates: "Tuesday", "Oct 4".
const dayLabel = (day: string, month: boolean) =>
  month ? formatMonthDay(new Date(`${day}T12:00:00`)) : formatWeekday(`${day}T12:00:00`);

/** The period's replies on each of the reader's days, today last and lit, with the busiest day named. */
export function DailyChart({ days }: { days: ReadonlyArray<DayUsage> }) {
  const most = Math.max(1, ...days.map((day) => day.replies));
  const month = days.length > 7;
  const first = days[0];
  const busiest = busiestDay(days);
  return (
    <div className="cut flex flex-col bg-card">
      <ol
        className={cn(
          "m-0 flex h-[140px] list-none items-end px-4 pt-4 pb-0",
          "bg-[repeating-linear-gradient(0deg,transparent_0_34px,var(--color-line)_34px_35px)] bg-origin-content",
          month ? "gap-[3px]" : "gap-2.5",
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
        <span>{first && dayLabel(first.day, month)}</span>
        {busiest && <span>{messages.daily.busiest({ day: dayLabel(busiest.day, month) })}</span>}
        <span>{messages.daily.today}</span>
      </div>
    </div>
  );
}
