import type { Agent } from "@hobbots/domain";
import { Button } from "@hobbots/ui/components/button";
import { FilterChip, FilterChips } from "@hobbots/ui/components/filter-chips";
import { PixelArt } from "@hobbots/ui/components/pixel-art";
import { cn } from "@hobbots/ui/lib/utils";
import { useQueries, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { useActivity } from "../../api/activity.ts";
import { agentsQuery, threadsQuery } from "../../api/queries.ts";
import { useQuestWork } from "../../api/quest-work.ts";
import { HOME_VILLAGE, HOME_VILLAGE_PALETTE } from "../../art/home-village.ts";
import { splitScene } from "../../lib/crew.ts";
import { sceneOrder, withRequests } from "../../lib/hob-state.ts";
import { questsInProgress } from "../../lib/quest-work.ts";
import { greeting } from "../../lib/time.ts";
import { WorkHeldNotice } from "../backup/work-held-notice.tsx";
import { HobSprite, hobState } from "../hob-sprite/hob-sprite.tsx";
import type { HobFilter } from "../hobs-page/hobs-page-model.ts";
import { useWaitingHobs } from "../inbox/use-waiting-count.ts";
import { messages } from "../messages.ts";
import { Stars } from "../scene/scene.tsx";
import { activeFilter, homeSummary, inFilter, sceneChips } from "./home-model.ts";
import { NeedsYou } from "./needs-you.tsx";
import { PickUp } from "./pick-up.tsx";
import { PlanLine } from "./plan-line.tsx";
import { StageHob } from "./stage-hob.tsx";
import { useStageFit } from "./use-stage-fit.ts";

/** Home, the landing page: what your hobs are doing, what needs you, and what is left of the Claude Code plan. */
export function Home() {
  const agents = useQuery(agentsQuery);
  const hobs = agents.data ?? [];
  const threadLists = useQueries({ queries: hobs.map((hob) => threadsQuery(hob.id)) });
  const activity = useActivity();
  const waitingHobs = useWaitingHobs();
  const [picked, setPicked] = useState<HobFilter>("all");
  const [stageBox, setStageBox] = useState<HTMLDivElement | null>(null);

  const crew = sceneOrder(
    hobs.map((hob, index) => {
      const threads = threadLists[index]?.data ?? [];
      return { hob, threads, state: withRequests(hobState(hob, threads, activity), waitingHobs.has(hob.id)) };
    }),
  );
  const { stage } = splitScene(crew);
  // The hobs the stage has no room for, at a narrow window, wait in the hall with the rest.
  const fit = useStageFit(stageBox, stage.length);
  const hall = crew.length - fit;
  const many = hall > 0;
  const recent = crew
    .flatMap((c) => c.threads.map((thread) => ({ hob: c.hob, thread })))
    .sort((a, b) => b.thread.updatedAt.localeCompare(a.thread.updatedAt));
  const quests = questsInProgress(useQuestWork(hobs.map((hob) => hob.id)));
  const byId = new Map(hobs.map((hob) => [hob.id, hob]));

  const chips = sceneChips(crew.map((c) => c.state));
  const filter = activeFilter(picked, chips);
  return (
    <main className="flex min-w-0 flex-1 flex-col overflow-y-auto">
      <section
        aria-label={messages.home.landmark}
        className="@container relative h-[262px] flex-none overflow-hidden bg-scene-sky"
      >
        <Sky />
        <div className={cn("absolute inset-x-0 top-[34px] bottom-1.5 flex gap-6 ps-9", many ? "pe-[196px]" : "pe-11")}>
          <SceneText summary={homeSummary(crew)} chips={chips} filter={filter} onFilter={setPicked} />

          {/* The stage takes the room the text leaves. A hob with no room wraps onto a line above,
              which the stage hides, so no hob ever covers the text or Summon. */}
          <div
            ref={setStageBox}
            className="flex min-w-0 flex-1 flex-wrap-reverse content-start items-start justify-end gap-3 overflow-hidden p-1 @5xl:gap-7"
          >
            {stage.map(({ hob, state, threads }, index) => (
              <div key={hob.id} className={cn(index >= fit && "invisible")}>
                <StageHob
                  hob={hob}
                  state={state}
                  threads={threads}
                  activity={activity}
                  size={56}
                  dimmed={!inFilter(state, filter)}
                />
              </div>
            ))}
          </div>
        </div>

        {many && <HallDoor count={hall} peek={crew[fit]?.hob} filter={filter} />}
      </section>
      <WorkHeldNotice className="mx-7 mt-5" />

      <div className="mx-auto flex w-full max-w-home-max flex-col gap-7 px-8 pt-6 pb-8">
        <NeedsYou />
        <PickUp chats={recent} quests={quests} hobs={byId} activity={activity} />
        <PlanLine />
      </div>
    </main>
  );
}

/**
 * Home's night sky and village, in every theme: the village with its lit windows and the lane the hobs
 * stand in, a shade on the left so the greeting reads, and the moon over the stars, or the sun in the
 * light themes.
 */
function Sky() {
  return (
    <>
      <PixelArt
        rows={HOME_VILLAGE}
        palette={HOME_VILLAGE_PALETTE}
        size={160}
        preserveAspectRatio="xMidYMax slice"
        className="absolute inset-0 size-full"
      />
      <div
        aria-hidden
        className="absolute inset-0 bg-linear-to-r from-scene-sky/82 from-0% via-scene-sky/55 via-32% to-transparent to-55%"
      />
      <div aria-hidden className="hidden dark:contents">
        <Stars count={16} height={100} tone="moonlight" />
      </div>
      <div
        aria-hidden
        className="absolute end-12 top-7 size-10 rounded-dot bg-scene-sun shadow-[0_0_0_8px_color-mix(in_srgb,var(--color-scene-sun)_25%,transparent)] dark:bg-moonlight dark:shadow-[0_0_0_8px_color-mix(in_srgb,var(--color-moonlight)_8%,transparent)]"
      />
    </>
  );
}

/** The greeting, the summary line, the count chips and Summon, at the start of the scene. */
function SceneText({
  summary,
  chips,
  filter,
  onFilter,
}: {
  summary: string;
  chips: ReturnType<typeof sceneChips>;
  filter: HobFilter;
  onFilter: (filter: HobFilter) => void;
}) {
  return (
    <div className="flex max-w-[470px] flex-none flex-col gap-2.5">
      <h1 className="m-0 font-heading text-[34px] font-bold text-scene-title text-shadow-[0_2px_0_var(--color-scene-sky)]">
        {greeting()}
      </h1>
      <p className="m-0 text-[17px] leading-normal text-scene-text">{summary}</p>
      <div className="flex flex-wrap items-center gap-2 pt-1">
        <FilterChips
          aria-label={messages.home.chips.label}
          value={filter}
          onValueChange={(value) => onFilter(value as HobFilter)}
        >
          {chips.map(({ value, count }) => (
            <FilterChip key={value} value={value} count={count} className="data-[state=off]:bg-card">
              {messages.home.chips[value]}
            </FilterChip>
          ))}
        </FilterChips>
        <SummonLink />
      </div>
    </div>
  );
}

function SummonLink() {
  return (
    <Button asChild variant="ghost" size="sm">
      <Link to="/summon">{messages.home.summon}</Link>
    </Button>
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
