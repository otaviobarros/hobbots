import { MOON, MOON_PALETTE } from "@hobbots/art/moon";
import type { Agent, Thread } from "@hobbots/domain";
import { FilterChip, FilterChips } from "@hobbots/ui/components/filter-chips";
import { PixelArt } from "@hobbots/ui/components/pixel-art";
import { cn } from "@hobbots/ui/lib/utils";
import { useQueries, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { type ActivityMap, useActivity } from "../../api/activity.ts";
import { agentsQuery, threadsQuery } from "../../api/queries.ts";
import { useQuestWork } from "../../api/quest-work.ts";
import { type CrewGroup, groupOf, SCENE_LIMIT, splitScene } from "../../lib/crew.ts";
import { sceneOrder, withRequests } from "../../lib/hob-state.ts";
import { questsInProgress } from "../../lib/quest-work.ts";
import { greeting } from "../../lib/time.ts";
import { WorkHeldNotice } from "../backup/work-held-notice.tsx";
import { HobSprite, hobState } from "../hob-sprite/hob-sprite.tsx";
import type { HobFilter } from "../hobs-page/hobs-page-model.ts";
import { useWaitingHobs } from "../inbox/use-waiting-count.ts";
import { messages } from "../messages.ts";
import { Stars } from "../scene/scene.tsx";
import { activeFilter, inFilter, sceneChips } from "./home-model.ts";
import { NeedsYou } from "./needs-you.tsx";
import { PickUp } from "./pick-up.tsx";
import { PlanLine } from "./plan-line.tsx";
import { StageHob } from "./stage-hob.tsx";

/** Home, the landing page: what your hobs are doing, what needs you, and what is left of the Claude Code plan. */
export function Home() {
  const agents = useQuery(agentsQuery);
  const hobs = agents.data ?? [];
  const threadLists = useQueries({ queries: hobs.map((hob) => threadsQuery(hob.id)) });
  const activity = useActivity();
  const waitingHobs = useWaitingHobs();
  const [picked, setPicked] = useState<HobFilter>("all");

  const crew = sceneOrder(
    hobs.map((hob, index) => {
      const threads = threadLists[index]?.data ?? [];
      return { hob, threads, state: withRequests(hobState(hob, threads, activity), waitingHobs.has(hob.id)) };
    }),
  );
  const { stage, hall } = splitScene(crew);
  const many = hall > 0;
  const count = (group: CrewGroup) => crew.filter((c) => groupOf(c.state) === group).length;
  const busy = count("working");
  const paused = count("paused");
  const recent = crew
    .flatMap((c) => c.threads.map((thread) => ({ hob: c.hob, thread })))
    .sort((a, b) => b.thread.updatedAt.localeCompare(a.thread.updatedAt));
  const live = recent.filter(({ thread }) => activity[thread.id]);
  const quests = questsInProgress(useQuestWork(hobs.map((hob) => hob.id)));
  const byId = new Map(hobs.map((hob) => [hob.id, hob]));

  const chips = sceneChips(crew.map((c) => c.state));
  const filter = activeFilter(picked, chips);
  return (
    <main className="flex min-w-0 flex-1 flex-col overflow-y-auto">
      <section
        aria-label={messages.home.landmark}
        className="@container relative h-[262px] flex-none overflow-hidden border-b-4 border-line bg-panel"
      >
        <Stars count={28} height={190} />
        <PixelArt
          rows={MOON}
          palette={MOON_PALETTE}
          size={60}
          className={cn("absolute top-[26px] animate-hb-flicker", many ? "end-[230px]" : "end-[60px]")}
        />
        <div aria-hidden className="absolute inset-x-0 bottom-0 h-[62px] border-t-[6px] border-line-2 bg-line" />

        <div className="absolute top-[34px] start-9 flex max-w-[470px] flex-col gap-2.5">
          <h1 className="m-0 font-heading text-[34px] font-bold text-moonlight">{greeting()}</h1>
          <p className="m-0 text-[17px] leading-normal">{summary(crew.length, busy, paused, hall, crew[0]?.hob)}</p>
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <FilterChips
              aria-label={messages.home.chips.label}
              value={filter}
              onValueChange={(value) => setPicked(value as HobFilter)}
            >
              {chips.map(({ value, count }) => (
                <FilterChip key={value} value={value} count={count}>
                  {messages.home.chips[value]}
                </FilterChip>
              ))}
            </FilterChips>
            <SummonLink />
          </div>
        </div>

        <div
          className={cn("absolute bottom-[34px] flex items-end gap-3 @5xl:gap-7", many ? "end-[200px]" : "end-[150px]")}
        >
          {stage.map(({ hob, state, threads }) => (
            <StageHob
              key={hob.id}
              hob={hob}
              state={state}
              threads={threads}
              activity={activity}
              size={56}
              dimmed={!inFilter(state, filter)}
            />
          ))}
        </div>

        {many && <HallDoor count={hall} peek={crew[SCENE_LIMIT]?.hob} filter={filter} />}
      </section>
      <WorkHeldNotice className="mx-7 mt-5" />

      <div className="mx-auto flex w-full max-w-[880px] flex-col gap-7 px-8 pt-6 pb-8">
        <NeedsYou />
        <PickUp chats={recent} quests={quests} hobs={byId} activity={activity} />
        <HappeningNowCard live={live} activity={activity} />
        <PlanLine />
      </div>
    </main>
  );
}

function SummonLink() {
  return (
    <Link to="/summon" className="bg-deep px-2.5 py-1 text-[13px] text-lantern no-underline hover:bg-line">
      {messages.home.summon}
    </Link>
  );
}

function LiveDot() {
  return (
    <>
      <span aria-hidden className="size-2 animate-hb-blink rounded-dot bg-rose" />
      <span className="text-xs text-text-secondary">{messages.home.live}</span>
    </>
  );
}

/**
 * The hall at the right of the scene: a lit house whose tag counts the hobs inside. Its door opens
 * Your hobs, on the family a count chip picked.
 */
function HallDoor({ count, peek, filter }: { count: number; peek: Agent | undefined; filter: HobFilter }) {
  return (
    <Link
      to="/hobs"
      search={filter === "all" ? {} : { show: filter }}
      aria-label={messages.home.hall.open({ count })}
      className="hop-on-hover absolute end-9 bottom-[34px] h-[120px] w-[150px] no-underline"
    >
      <span aria-hidden className="absolute inset-x-0 bottom-0 h-[84px] bg-scene-wall" />
      <span
        aria-hidden
        className="absolute -inset-x-2.5 bottom-[84px] h-9 bg-scene-roof [clip-path:polygon(50%_0,100%_100%,0_100%)]"
      />
      <span aria-hidden className="absolute bottom-11 start-[18px] h-5 w-6 animate-hb-flicker bg-lantern" />
      <span aria-hidden className="absolute bottom-0 start-[58px] h-14 w-10 bg-scene-door" />
      {peek && (
        <span aria-hidden className="absolute bottom-1 start-[66px]">
          <HobSprite hob={peek} size={24} />
        </span>
      )}
      <span className="absolute top-2 -end-1.5 rounded-tag bg-text-strong px-[7px] py-[3px] text-xs font-bold text-ground">
        {messages.home.hall.tag({ count })}
      </span>
    </Link>
  );
}

const summary = (count: number, busy: number, paused: number, hall: number, first: Agent | undefined) => {
  if (count === 0 || !first) return "No hobs yet.";
  if (hall > 0)
    return `${count} hobs. Those who need you, then the busiest, step outside; the other ${hall} wait in the hall.`;
  if (count === 1) {
    if (busy > 0) return `${first.name} is working on a reply for you.`;
    return paused > 0 ? `${first.name} is paused until you wake them.` : `${first.name} is ready when you are.`;
  }
  const working =
    busy === 0
      ? "None of your hobs are working right now"
      : `${busy} of your ${count} hobs ${busy === 1 ? "is" : "are"} working`;
  if (paused > 0) return `${working}, and ${paused} ${paused === 1 ? "is" : "are"} paused.`;
  return busy > 0 ? `${working} right now.` : `Your ${count} hobs are ready when you are.`;
};

function Card({
  label,
  extra,
  className,
  labelClass,
  children,
}: {
  label: string;
  extra?: React.ReactNode;
  className?: string;
  labelClass?: string;
  children: React.ReactNode;
}) {
  return (
    <section
      aria-label={label}
      className={cn("cut flex min-w-0 flex-col gap-2.5 border-2 border-line bg-card px-[18px] py-4", className)}
    >
      <div className="flex items-center gap-2">
        <span className={cn("lbl text-moonlight", labelClass)}>{label}</span>
        {extra}
      </div>
      {children}
    </section>
  );
}

/** Every reply streaming right now; each opens its thread. */

function HappeningNowCard({
  live,
  activity,
}: {
  live: ReadonlyArray<{ hob: Agent; thread: Thread }>;
  activity: ActivityMap;
}) {
  return (
    <Card label={messages.home.happeningNow} extra={live.length > 0 && <LiveDot />}>
      {live.length === 0 ? (
        <p className="m-0 text-sm text-text-secondary">{messages.home.allQuiet}</p>
      ) : (
        <HappeningNow live={live} activity={activity} />
      )}
    </Card>
  );
}

function HappeningNow({
  live,
  activity,
}: {
  live: ReadonlyArray<{ hob: Agent; thread: Thread }>;
  activity: ActivityMap;
}) {
  return live.map(({ hob, thread }) => {
    const sentence = messages.home.activity[activity[thread.id] === "thinking" ? "thinking" : "writing"];
    const text = sentence({ title: thread.title });
    // The name comes first in the message, so a title that holds "{name}" is never split.
    const at = text.indexOf("{name}");
    const [before, after] = [text.slice(0, at), text.slice(at + "{name}".length)];
    return (
      <Link
        key={thread.id}
        to="/hobs/$hobId/threads/$threadId"
        params={{ hobId: hob.id, threadId: thread.id }}
        className="flex animate-hb-in items-center gap-2.5 text-text-strong no-underline"
      >
        <HobSprite hob={hob} size={26} state={activity[thread.id] ?? "working"} />
        <span className="min-w-0 flex-1 text-sm leading-snug">
          {before}
          <b>{hob.name}</b>
          {after}
        </span>
      </Link>
    );
  });
}
