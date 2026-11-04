import { HOB_COLORS } from "@hobbots/art/look";
import type { Agent, AgentId, Thread } from "@hobbots/domain";
import { Empty } from "@hobbots/ui/components/empty";
import { Progress } from "@hobbots/ui/components/progress";
import { Link } from "@tanstack/react-router";
import type { CSSProperties, ReactNode } from "react";
import type { ActivityMap } from "../../api/activity.ts";
import type { QuestInProgress } from "../../lib/quest-work.ts";
import { formatWhen } from "../../lib/time.ts";
import { HobSprite } from "../hob-sprite/hob-sprite.tsx";
import { QuestLink } from "../quest-work/quest-link.tsx";
import { type PickUpRow, pickUpRows, questProgress } from "./home-model.ts";
import { messages } from "./messages.ts";

const copy = messages.pickUp;

const rowClass =
  "grid grid-cols-[36px_minmax(0,1fr)_auto] items-start gap-3 py-3 ps-3.5 pe-4 text-inherit no-underline transition-colors hover:bg-hover";

/**
 * Pick up where you left off: recent chats and Quests in progress in one list, the most recently
 * active first. Each row has its hob's portrait, its title, a line on where it stands and its age;
 * a Quest also shows how far its party got.
 */
export function PickUp({
  chats,
  quests,
  hobs,
  activity,
}: {
  chats: ReadonlyArray<{ readonly hob: Agent; readonly thread: Thread }>;
  quests: ReadonlyArray<QuestInProgress>;
  hobs: ReadonlyMap<AgentId, Agent>;
  activity: ActivityMap;
}) {
  const rows = pickUpRows(chats, quests);
  return (
    <section aria-label={copy.title} className="flex flex-col gap-2.5">
      <div className="flex items-center gap-2 text-label">
        <ChatIcon />
        <h2 className="lbl m-0 text-label">{copy.title}</h2>
        <Link
          to="/hobs"
          className="ms-auto inline-flex items-center gap-1 rounded-control px-2 py-[3px] text-detail text-link no-underline hover:bg-hover"
        >
          {copy.yourHobs}
          <span aria-hidden>→</span>
        </Link>
      </div>
      {rows.length === 0 ? (
        <Empty surface="card">{copy.empty}</Empty>
      ) : (
        <ul className="m-0 flex list-none flex-col overflow-hidden rounded-card bg-card p-0">
          {rows.map((row) => (
            <li
              key={row.kind === "thread" ? row.thread.id : row.group.quest.id}
              className="border-t border-line first:border-t-0"
            >
              <Row row={row} hobs={hobs} activity={activity} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Row({
  row,
  hobs,
  activity,
}: {
  row: PickUpRow<Agent, Thread>;
  hobs: ReadonlyMap<AgentId, Agent>;
  activity: ActivityMap;
}) {
  if (row.kind === "thread") {
    const { hob, thread } = row;
    const now = activity[thread.id];
    return (
      <Link to="/hobs/$hobId/threads/$threadId" params={{ hobId: hob.id, threadId: thread.id }} className={rowClass}>
        <Tile hob={hob} />
        <Body title={thread.title} who={hob.name}>
          {now === undefined ? thread.lastLine : now === "working" ? copy.writing : copy.thinking}
        </Body>
        <Age at={row.at} />
      </Link>
    );
  }
  const { group } = row;
  const lead = hobs.get(group.quest.leadId);
  const { done, total, needs } = questProgress(group);
  return (
    <QuestLink quest={group.quest} threadAgentId={group.threadAgentId} taskId={group.quest.taskId} className={rowClass}>
      {lead ? <Tile hob={lead} /> : <span />}
      <span className="flex min-w-0 flex-col gap-0.5">
        <Body title={group.quest.goal} who={lead?.name ?? ""}>
          {copy.progress({ done, total })}
        </Body>
        <span className="flex items-center gap-2 pt-1">
          <Progress aria-hidden size="sm" value={done} max={total} className="max-w-[160px]" />
          {needs > 0 && (
            <span className="rounded-tag bg-lantern px-2 text-meta leading-6 font-bold whitespace-nowrap text-on-lantern">
              {copy.needs({ count: needs })}
            </span>
          )}
        </span>
      </span>
      <Age at={row.at} />
    </QuestLink>
  );
}

/** The row's hob on a tile in its hat color, as on the Workbench header. */
function Tile({ hob }: { hob: Agent }) {
  return (
    <span
      aria-hidden
      className="flex size-9 items-center justify-center rounded-tile bg-[color-mix(in_srgb,var(--hob)_30%,var(--color-card))]"
      style={{ "--hob": HOB_COLORS[hob.lookColor].hat } as CSSProperties}
    >
      <HobSprite hob={hob} size={27} />
    </span>
  );
}

/** The row's title, then who it is with and, when there is one, where it stands. */
function Body({ title, who, children }: { title: string; who: string; children: ReactNode }) {
  return (
    <span className="flex min-w-0 flex-col gap-0.5">
      <span className="truncate text-[15px] leading-[22px] font-semibold text-text-strong">{title}</span>
      <span className="truncate text-ui text-text-secondary">
        <b className="font-semibold text-text">{who}</b>
        {children !== null && children !== "" && <> · {children}</>}
      </span>
    </span>
  );
}

function Age({ at }: { at: string }) {
  return <span className="text-meta leading-[22px] whitespace-nowrap text-label">{formatWhen(at)}</span>;
}

function ChatIcon() {
  return (
    <svg
      aria-hidden
      viewBox="0 0 16 16"
      className="size-3.5"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z" />
    </svg>
  );
}
