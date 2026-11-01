import { MOON, MOON_PALETTE } from "@hobbots/art/moon";
import type { Agent, Thread } from "@hobbots/domain";
import { PixelArt } from "@hobbots/ui/components/pixel-art";
import { cn } from "@hobbots/ui/lib/utils";
import { useQueries, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useRef, useState } from "react";
import { type ActivityMap, useActivity } from "../api/activity.ts";
import { agentsQuery, runtimesQuery, threadsQuery } from "../api/queries.ts";
import { potion, potionPalette } from "../art/icons.ts";
import {
  type CrewGroup,
  foldsByDefault,
  groupCrew,
  groupOf,
  groupOrder,
  matchesHob,
  SCENE_LIMIT,
  splitScene,
} from "../lib/crew.ts";
import { sceneOrder, withRequests } from "../lib/hob-state.ts";
import { formatWhen, greeting } from "../lib/time.ts";
import { HobSprite, type HobState, hobState, stateLabel } from "./hob-sprite.tsx";
import { useWaitingHobs } from "./inbox/use-waiting-count.ts";
import { WaitingRequests } from "./inbox/waiting-requests.tsx";
import { messages } from "./messages.ts";
import { Stars } from "./scene.tsx";

/** Home, the landing page: what your hobs are doing, what needs you, and what is left of each AI plan. */
// complexity-ignore: predates the limit (STD-ARCH-012). Split it before adding branches.
export function Home() {
  const agents = useQuery(agentsQuery);
  const hobs = agents.data ?? [];
  const threadLists = useQueries({ queries: hobs.map((hob) => threadsQuery(hob.id)) });
  const activity = useActivity();
  const waitingHobs = useWaitingHobs();
  const [folded, setFolded] = useState<Partial<Record<CrewGroup, boolean>>>({});
  const [query, setQuery] = useState("");
  const filterRef = useRef<HTMLInputElement>(null);

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

  // A count chip clears the filter, unfolds its group and, once drawn, moves focus to its header,
  // which scrolls it into view.
  const jumpTo = (group: CrewGroup) => {
    setQuery("");
    setFolded((current) => ({ ...current, [group]: false }));
    requestAnimationFrame(() => document.getElementById(groupHeaderId(group))?.focus());
  };
  // The door opens the hall: every group unfolds and the filter is ready to find anyone.
  const openHall = () => {
    setFolded(Object.fromEntries(groupOrder.map((group) => [group, false])));
    filterRef.current?.focus();
  };
  const chip = (group: CrewGroup, text: string, className: string) =>
    many && count(group) > 0 ? (
      <button type="button" onClick={() => jumpTo(group)} className={cn(chipClass, "hover:bg-line", className)}>
        {text}
      </button>
    ) : (
      <span className={cn(chipClass, className)}>{text}</span>
    );

  return (
    <main className="flex min-w-0 flex-1 flex-col overflow-y-auto">
      <section
        aria-label="Your hobs right now"
        className={cn(
          "relative flex-none overflow-hidden border-b-4 border-line bg-panel",
          many ? "h-[196px]" : "h-[262px]",
        )}
      >
        <Stars count={many ? 20 : 28} height={many ? 130 : 190} />
        {!many && (
          <PixelArt
            rows={MOON}
            palette={MOON_PALETTE}
            size={60}
            className="absolute top-[26px] right-[60px] animate-hb-flicker"
          />
        )}
        <div
          aria-hidden
          className={cn(
            "absolute inset-x-0 bottom-0 border-t-[6px] border-line-2 bg-line",
            many ? "h-[46px]" : "h-[62px]",
          )}
        />

        <div
          className={cn(
            "absolute flex flex-col",
            many ? "top-5 left-7 max-w-[420px] gap-2" : "top-[34px] left-9 max-w-[470px] gap-2.5",
          )}
        >
          <h1 className={cn("m-0 font-pixel font-bold text-moonlight", many ? "text-[28px]" : "text-[34px]")}>
            {greeting()}
          </h1>
          <p className={cn("m-0 leading-normal", many ? "text-secondary-text" : "text-[17px]")}>
            {summary(crew.length, busy, paused, hall, crew[0]?.hob)}
          </p>
          <div className="flex flex-wrap gap-2 pt-1">
            {chip("working", `${busy} working`, busy > 0 ? "text-mint" : "")}
            {chip("needs-you", `${count("needs-you")} need you`, "text-lantern")}
            {count("waiting") > 0 && chip("waiting", `${count("waiting")} waiting`, "text-label")}
            {chip("resting", `${count("resting")} resting`, "text-secondary-text")}
            {paused > 0 && chip("paused", `${paused} paused`, "text-secondary-text")}
            {!many && <SummonLink />}
          </div>
        </div>

        <div
          className={cn(
            "absolute bottom-[34px] flex items-end",
            many ? "right-[210px] gap-[22px]" : "right-[150px] gap-11",
          )}
        >
          {stage.map(({ hob, state }) => (
            <Link
              key={hob.id}
              to="/hobs/$hobId"
              params={{ hobId: hob.id }}
              aria-label={openChatLabel(hob, state)}
              className="hop-on-hover flex flex-col items-center gap-1.5 text-ground no-underline"
            >
              <span
                className={cn(
                  "flex flex-col items-center bg-text whitespace-nowrap",
                  many ? "px-1.5 py-0.5 text-xs" : "px-2 py-[3px] text-xs",
                )}
              >
                <span>{many ? hob.name : sceneTag(hob, state)}</span>
                <span className="font-bold">{hob.roleTitle}</span>
              </span>
              {!many && (
                <span aria-hidden className="block h-1.5 w-16 bg-line-2">
                  {(state === "working" || state === "thinking") && (
                    <span className="block h-full w-full animate-hb-tick bg-mint" />
                  )}
                </span>
              )}
              <HobSprite hob={hob} size={many ? 52 : 64} state={state} badge />
            </Link>
          ))}
        </div>

        {many && <HallDoor count={hall} peek={crew[SCENE_LIMIT]?.hob} onOpen={openHall} />}
      </section>

      {many ? (
        <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_300px] gap-4 px-[22px] py-4">
          <AllHobs
            crew={crew}
            folded={folded}
            onFold={(group, fold) => setFolded((current) => ({ ...current, [group]: fold }))}
            query={query}
            onQuery={setQuery}
            filterRef={filterRef}
          />
          <div className="flex min-w-0 flex-col gap-3.5">
            <NeedsYou />
            <HappeningNowCard live={live} activity={activity} />
            <AiPlans />
          </div>
        </div>
      ) : (
        <div className="grid min-h-0 flex-1 grid-cols-[1.15fr_1fr_0.9fr] gap-[18px] px-6 py-5">
          <NeedsYou />

          <div className="flex min-w-0 flex-col gap-[18px]">
            <HappeningNowCard live={live} activity={activity} />
            <Card label="Recent threads" className="flex-1">
              {recent.length === 0 && <p className="m-0 text-sm text-secondary-text">No threads yet.</p>}
              {recent.slice(0, 4).map(({ hob, thread }) => (
                <Link
                  key={thread.id}
                  to="/hobs/$hobId/threads/$threadId"
                  params={{ hobId: hob.id, threadId: thread.id }}
                  className="flex gap-2.5 text-sm leading-snug text-text no-underline hover:text-moonlight"
                >
                  <span className="w-16 flex-none font-pixel font-semibold text-moonlight">{hob.name}</span>
                  <span className="min-w-0 flex-1 truncate text-secondary-text">{thread.title}</span>
                  <span className="text-xs text-label">{formatWhen(thread.updatedAt)}</span>
                </Link>
              ))}
            </Card>
          </div>

          <div className="flex min-w-0 flex-col gap-[18px]">
            <AiPlans />
            <Card label="Quests in progress" className="flex-1">
              <p className="m-0 text-sm leading-normal text-secondary-text">
                No quests yet. When hobs share work, each Quest shows here with who is on it and how far it got.
              </p>
            </Card>
          </div>
        </div>
      )}
    </main>
  );
}

function SummonLink() {
  return (
    <Link to="/summon" className="bg-deep px-2.5 py-1 text-[13px] text-lantern no-underline hover:bg-line">
      + Summon a hob
    </Link>
  );
}

const chipClass = "bg-deep px-2.5 py-1 text-[13px] text-text";

function LiveDot() {
  return (
    <>
      <span aria-hidden className="size-2 animate-hb-blink bg-rose" />
      <span className="text-xs text-secondary-text">live</span>
    </>
  );
}

function NeedsYou() {
  return (
    <Card label="Needs you" className="border-[3px] border-lantern" labelClass="text-lantern">
      <WaitingRequests
        empty={
          <p className="m-0 border-t-2 border-line pt-3 leading-normal text-secondary-text">
            Nothing needs you right now. When a hob asks permission or has a question, it waits here and you can open it
            in the Inbox.
          </p>
        }
      />
    </Card>
  );
}

/** The hall at the right of the scene; its door shows how many hobs wait inside and opens the full list. */
function HallDoor({ count, peek, onOpen }: { count: number; peek: Agent | undefined; onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={`Open the hall: ${count} more ${count === 1 ? "hob" : "hobs"}`}
      className="hop-on-hover absolute right-9 bottom-[34px] h-[120px] w-[150px] bg-transparent p-0"
    >
      <span aria-hidden className="absolute inset-x-0 bottom-0 h-[84px] bg-[#3d2f52]" />
      <span
        aria-hidden
        className="absolute -inset-x-2.5 bottom-[84px] h-9 bg-[#5b3f5e] [clip-path:polygon(50%_0,100%_100%,0_100%)]"
      />
      <span aria-hidden className="absolute bottom-11 left-[18px] h-5 w-6 animate-hb-flicker bg-lantern" />
      <span aria-hidden className="absolute bottom-0 left-[58px] h-14 w-10 bg-[#241c33]" />
      {peek && (
        <span aria-hidden className="absolute bottom-1 left-[66px]">
          <HobSprite hob={peek} size={24} />
        </span>
      )}
      <span
        aria-hidden
        className="absolute bottom-[50px] left-[98px] animate-hb-float font-pixel text-sm text-secondary-text"
      >
        z
      </span>
      <span className="cut absolute top-2 -right-1.5 bg-text px-[7px] py-[3px] text-xs font-bold text-ground">
        {count} in the hall
      </span>
    </button>
  );
}

const groupInfo: Record<CrewGroup, { label: string; dot: string; hint?: string }> = {
  "needs-you": { label: "Needs you", dot: "bg-lantern", hint: "answer first" },
  working: { label: "Working", dot: "bg-mint" },
  waiting: { label: "Waiting", dot: "bg-control" },
  failed: { label: "Had a problem", dot: "bg-rose" },
  resting: { label: "Resting", dot: "bg-label", hint: "idle, no chores" },
  paused: { label: "Paused", dot: "bg-line-2" },
};

const groupHeaderId = (group: CrewGroup) => `crew-${group}`;

/** Every hob as a tile, grouped by state, with a filter by name or role. */
function AllHobs({
  crew,
  folded,
  onFold,
  query,
  onQuery,
  filterRef,
}: {
  crew: ReadonlyArray<{ hob: Agent; state: HobState }>;
  folded: Partial<Record<CrewGroup, boolean>>;
  onFold: (group: CrewGroup, fold: boolean) => void;
  query: string;
  onQuery: (query: string) => void;
  filterRef: React.RefObject<HTMLInputElement | null>;
}) {
  const filtering = query.trim() !== "";
  const groups = groupCrew(crew.filter((c) => matchesHob(c.hob, query)));

  return (
    <section aria-label="All hobs" className="cut flex min-h-0 min-w-0 flex-col gap-2.5 bg-panel px-4 py-3.5">
      <div className="flex items-center gap-2.5">
        <span className="lbl text-moonlight">Your hobs</span>
        <span className="text-xs text-label">⌘K jumps to any hob</span>
        <span className="ml-auto">
          <SummonLink />
        </span>
        <input
          ref={filterRef}
          type="search"
          value={query}
          onChange={(event) => onQuery(event.target.value)}
          placeholder="Find a hob"
          aria-label="Find a hob by name or role"
          className="w-[200px] border-2 border-control bg-deep px-2 py-[5px] text-[13px] text-text placeholder:text-label"
        />
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto pr-1">
        {groups.length === 0 && <p className="m-0 text-sm text-secondary-text">No hob matches “{query.trim()}”.</p>}
        {groups.map(({ group, members }) => {
          // A filter opens every group, so a match is never hidden.
          const open = filtering || !(folded[group] ?? foldsByDefault(group, crew.length));
          const info = groupInfo[group];
          return (
            <div key={group} className="flex flex-col gap-1.5">
              <button
                id={groupHeaderId(group)}
                type="button"
                aria-expanded={open}
                aria-controls={`${groupHeaderId(group)}-tiles`}
                disabled={filtering}
                onClick={() => onFold(group, open)}
                className="flex w-full scroll-mt-2 items-center gap-2 bg-transparent py-1 text-left text-text"
              >
                <span aria-hidden className="w-2.5 text-label">
                  {open ? "▾" : "▸"}
                </span>
                <span aria-hidden className={cn("size-2", info.dot)} />
                <span className="text-sm font-bold">{info.label}</span>
                <span className="text-[13px] text-label">{members.length}</span>
                <span aria-hidden className="ml-1.5 h-0.5 flex-1 bg-line" />
                {info.hint && <span className="text-xs text-label">{info.hint}</span>}
              </button>
              {open && (
                <div
                  id={`${groupHeaderId(group)}-tiles`}
                  className="grid animate-hb-in grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-1.5"
                >
                  {members.map(({ hob, state }) => (
                    <Link
                      key={hob.id}
                      to="/hobs/$hobId"
                      params={{ hobId: hob.id }}
                      aria-label={openChatLabel(hob, state)}
                      title={`${hob.name} · ${hob.roleTitle} · ${stateLabel[state]}`}
                      className="cut hop-on-hover flex min-w-0 items-center gap-2 bg-card px-2 py-1.5 text-text no-underline hover:bg-line hover:text-text"
                    >
                      <HobSprite hob={hob} size={28} state={state} badge className="mr-1.5" />
                      <span className="flex min-w-0 flex-col">
                        <span className="truncate font-pixel text-sm font-semibold">{hob.name}</span>
                        <span className="truncate text-xs text-secondary-text">
                          {hob.roleTitle} · {stateLabel[state]}
                        </span>
                      </span>
                    </Link>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </section>
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

const sceneTagWords: Partial<Record<HobState, string>> = {
  working: "writing…",
  thinking: "thinking…",
  idle: "resting",
  paused: "paused",
};

const sceneTag = (hob: Agent, state: HobState) => `${hob.name} · ${sceneTagWords[state] ?? stateLabel[state]}`;

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
const openChatLabel = (hob: Agent, state: HobState) =>
  messages.home.openChat({ name: hob.name, role: hob.roleTitle, state: stateLabel[state] });

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
        <p className="m-0 text-sm text-secondary-text">{messages.home.allQuiet}</p>
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
  return live.map(({ hob, thread }) => (
    <Link
      key={thread.id}
      to="/hobs/$hobId/threads/$threadId"
      params={{ hobId: hob.id, threadId: thread.id }}
      className="flex animate-hb-in items-center gap-2.5 text-text no-underline"
    >
      <HobSprite hob={hob} size={26} state={activity[thread.id] ?? "working"} />
      <span className="min-w-0 flex-1 text-sm leading-snug">
        <b>{hob.name}</b> is {activity[thread.id] === "thinking" ? "thinking about" : "writing"} “{thread.title}”
      </span>
    </Link>
  ));
}

function AiPlans() {
  const runtimes = useQuery(runtimesQuery);
  const claude = runtimes.data?.[0];
  const ready = claude?.availability === "ready";
  const left = runtimes.isPending
    ? "Checking…"
    : ready
      ? planLabel(claude?.billing ?? null)
      : claude?.availability === "outdated"
        ? "Update needed"
        : claude?.availability === "signedOut"
          ? "Sign-in needed"
          : "Not connected";

  return (
    <Card label="AI plans">
      <div className="flex items-end gap-[18px] border-b-4 border-wood px-1.5">
        <Link
          to="/usage"
          aria-label={`Claude, ${left}`}
          className="hop-on-hover flex flex-col items-center gap-0.5 text-text no-underline"
        >
          <span className="sprite">
            <PixelArt rows={potion(ready ? 1 : 0)} palette={potionPalette("#e39a74", "#f3c4a8")} size={36} />
          </span>
          <span className="text-xs font-bold">Claude</span>
          <span className={cn("pb-1 text-xs", ready ? "text-mint" : "text-rose")}>{left}</span>
        </Link>
      </div>
      <span className="text-[13px] text-secondary-text">
        Plan limits show here once Claude reports them. More providers arrive with the MVP.
      </span>
    </Card>
  );
}

const planLabel = (billing: string | null) => {
  if (!billing) return "Connected";
  if (billing.startsWith("subscription")) return "Subscription";
  if (billing === "fake") return "Test runtime";
  return "API key";
};
