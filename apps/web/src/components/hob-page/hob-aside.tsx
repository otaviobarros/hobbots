import { type Agent, brainLabel } from "@hobbots/domain";
import { cn } from "@hobbots/ui/lib/utils";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { type ReactNode, useState } from "react";
import { agentsQuery } from "../../api/queries.ts";
import { useSummariesByQuest } from "../../api/quest-summaries.ts";
import { useQuestWork } from "../../api/quest-work.ts";
import { type LedQuest, ledQuests } from "../../lib/led-quests.ts";
import { questsInProgress } from "../../lib/quest-work.ts";
import { useHobWaiting } from "../backpack/use-hob-waiting.ts";
import { WaitingList } from "../backpack/waiting-list.tsx";
import { useHobPermissions } from "../hob-profile/hob-permissions.tsx";
import { QuestLink } from "../quest-work/quest-link.tsx";
import { messages } from "./messages.ts";

const copy = messages.aside;

/** How many of each block show before Show more. */
const SHOWN = { quests: 3, backpack: 4, folders: 3 } as const;

/**
 * The side column of a hob's page: the Quests it leads (those that need you first), its backpack,
 * the folders it works in and what it thinks with. Each long block shows a few, then Show more.
 */
export function HobAside({ hob }: { hob: Agent }) {
  return (
    <aside aria-label={copy.label({ name: hob.name })} className="flex min-w-0 flex-col gap-3">
      <LedQuests hob={hob} />
      <Backpack hob={hob} />
      <Setup hob={hob} />
    </aside>
  );
}

function Card({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section aria-label={label} className="cut flex min-w-0 flex-col gap-2.5 bg-card px-4 py-3.5">
      {children}
    </section>
  );
}

function Heading({ icon, label, count }: { icon: ReactNode; label: string; count?: number }) {
  return (
    <h2 className="lbl m-0 flex items-center gap-2 text-ui text-text-strong">
      <span aria-hidden className="flex size-4 text-label">
        {icon}
      </span>
      {label}
      {count !== undefined && (
        <span className="rounded-full bg-line px-[7px] py-px font-sans text-meta font-semibold tracking-normal text-text-secondary normal-case">
          {count}
        </span>
      )}
    </h2>
  );
}

function ShowMore({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="cursor-pointer self-start rounded-control bg-transparent px-2 py-1.5 text-ui text-link underline decoration-line-2 underline-offset-3 hover:bg-hover"
    >
      {children}
    </button>
  );
}

function LedQuests({ hob }: { hob: Agent }) {
  const hobs = useQuery(agentsQuery).data ?? [];
  const work = useQuestWork(hobs.map((each) => each.id));
  const [all, setAll] = useState(false);
  const { live, finished } = ledQuests(questsInProgress(work), useSummariesByQuest(), hob.id);
  if (live.length === 0 && finished === 0) return null;
  const shown = all ? live : live.slice(0, SHOWN.quests);
  return (
    <Card label={copy.quests.label}>
      <Heading icon={<FlagIcon />} label={copy.quests.label} count={live.length} />
      {shown.length > 0 && (
        <ul className="m-0 flex list-none flex-col gap-2 p-0">
          {shown.map((quest) => (
            <li key={quest.group.quest.id}>
              <QuestCard quest={quest} />
            </li>
          ))}
        </ul>
      )}
      {live.length > SHOWN.quests && (
        <ShowMore onClick={() => setAll(!all)}>
          {all ? copy.showFewer : copy.quests.showAll({ count: live.length })}
        </ShowMore>
      )}
      {finished > 0 && (
        <span className="flex items-center gap-1.5 text-detail leading-[18px] text-label">
          <span aria-hidden className="text-mint">
            ✓
          </span>
          {copy.quests.finished({ count: finished })}
        </span>
      )}
    </Card>
  );
}

function QuestCard({ quest }: { quest: LedQuest }) {
  const { group, done, total, needs } = quest;
  // At most ten segments, so a long Quest still fits the column.
  const segments = Math.min(total, 10);
  const filled = Math.round((done * segments) / Math.max(total, 1));
  return (
    <QuestLink
      quest={group.quest}
      threadAgentId={group.threadAgentId}
      taskId={group.quest.taskId}
      className="flex min-w-0 flex-col gap-1.5 rounded-control bg-deep px-3 py-2.5 text-text-strong no-underline hover:bg-hover hover:text-text-strong"
    >
      <strong title={group.quest.goal} className="line-clamp-2 text-ui leading-5">
        {group.quest.goal}
      </strong>
      <span aria-hidden className="flex gap-[3px]">
        {Array.from({ length: segments }, (_, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: segments are positions, never reordered
          <span key={index} className={cn("h-1 flex-1 rounded-[2px]", index < filled ? "bg-mint" : "bg-line-2")} />
        ))}
      </span>
      <span className={cn("truncate text-detail leading-[18px]", needs > 0 ? "text-lantern" : "text-text-secondary")}>
        {copy.quests.progress({ done, total, needs })}
      </span>
    </QuestLink>
  );
}

function Backpack({ hob }: { hob: Agent }) {
  const { now, view, hobs, openItem, count } = useHobWaiting(hob);
  const [all, setAll] = useState(false);
  const empty = count + view.handled.length + view.routine === 0;
  return (
    <Card label={copy.backpack.label}>
      <Heading icon={<PackIcon />} label={copy.backpack.label} count={count} />
      {empty ? (
        <span className="text-detail leading-[18px] text-label">{copy.backpack.empty}</span>
      ) : (
        <>
          <span className="text-detail leading-[18px] text-label">{copy.backpack.intro}</span>
          <WaitingList
            view={view}
            hobs={hobs}
            now={now}
            owners={false}
            limit={all ? Number.POSITIVE_INFINITY : SHOWN.backpack}
            onMore={() => setAll(true)}
            onOpen={(item) => void openItem(item)}
            label={copy.backpack.list({ name: hob.name })}
            className="-mx-2"
          />
        </>
      )}
    </Card>
  );
}

function Setup({ hob }: { hob: Agent }) {
  const folders = useHobPermissions(hob).data?.folders ?? [];
  const [all, setAll] = useState(false);
  const shown = all ? folders : folders.slice(0, SHOWN.folders);
  return (
    <Card label={copy.setup}>
      <div className="flex min-w-0 flex-col gap-1.5">
        <Heading icon={<FolderIcon />} label={copy.worksIn} />
        {folders.length === 0 ? (
          <span className="text-detail leading-[18px] text-label">{copy.noFolders}</span>
        ) : (
          <ul className="m-0 flex list-none flex-col gap-1 p-0">
            {shown.map((folder) => (
              <li key={folder} title={folder} className="truncate font-mono text-code leading-5 text-text">
                {folder}
              </li>
            ))}
          </ul>
        )}
        {folders.length > SHOWN.folders && (
          <ShowMore onClick={() => setAll(!all)}>
            {all ? copy.showFewer : copy.moreFolders({ count: folders.length - SHOWN.folders })}
          </ShowMore>
        )}
      </div>
      <div className="flex min-w-0 flex-col gap-1.5 border-t border-line pt-2.5">
        <Heading icon={<SparkIcon />} label={copy.thinksWith} />
        <span className="text-ui">{brainLabel(hob.runtime, hob.model)}</span>
      </div>
      <Link to="/hobs/$hobId/profile" params={{ hobId: hob.id }} className="text-detail text-link underline">
        {copy.change}
      </Link>
    </Card>
  );
}

const icon = (path: ReactNode) => (
  <svg
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    className="size-4"
  >
    {path}
  </svg>
);

const FlagIcon = () => icon(<path d="M3.5 14V2.5M3.5 3h8l-2 3 2 3h-8" />);
const PackIcon = () =>
  icon(
    <>
      <path d="M4 6a4 4 0 0 1 8 0v7H4z" />
      <path d="M6 6V4.5a2 2 0 0 1 4 0V6M6 10h4" />
    </>,
  );
const FolderIcon = () => icon(<path d="M2 4.5V12.5h12V6H8L6.5 4.5z" />);
const SparkIcon = () =>
  icon(<path d="M8 2v3M8 11v3M2 8h3M11 8h3M4 4l1.8 1.8M10.2 10.2 12 12M4 12l1.8-1.8M10.2 5.8 12 4" />);
