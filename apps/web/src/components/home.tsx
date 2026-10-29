import type { Agent, Thread } from "@hobbots/domain";
import { PixelArt } from "@hobbots/ui/components/pixel-art";
import { cn } from "@hobbots/ui/lib/utils";
import { useQueries, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { type ActivityMap, useActivity } from "../api/activity.ts";
import { agentsQuery, runtimesQuery, threadsQuery } from "../api/queries.ts";
import { MOON, MOON_PALETTE, potion, potionPalette } from "../art/icons.ts";
import { formatWhen, greeting } from "../lib/time.ts";
import { HobSprite, type HobState, hobStateFrom, stateLabel } from "./hob-sprite.tsx";
import { Stars } from "./scene.tsx";

// The scene shows at most six hobs: those who need you first, then the busiest.
const SCENE_LIMIT = 6;

/** Home, the landing page: what your hobs are doing, what needs you, and what is left of each AI plan. */
export function Home() {
  const agents = useQuery(agentsQuery);
  const hobs = agents.data ?? [];
  const threadLists = useQueries({ queries: hobs.map((hob) => threadsQuery(hob.id)) });
  const activity = useActivity();

  const crew = hobs.map((hob, index) => {
    const threads = threadLists[index]?.data ?? [];
    return { hob, threads, state: hobStateFrom(threads, activity) };
  });
  const busy = crew.filter((c) => c.state !== "idle");
  const recent = crew
    .flatMap((c) => c.threads.map((thread) => ({ hob: c.hob, thread })))
    .sort((a, b) => b.thread.updatedAt.localeCompare(a.thread.updatedAt));

  return (
    <main className="flex min-w-0 flex-1 flex-col overflow-y-auto">
      <section
        aria-label="Your hobs right now"
        className="relative h-[262px] flex-none overflow-hidden border-b-4 border-line bg-panel"
      >
        <Stars count={28} height={190} />
        <PixelArt
          rows={MOON}
          palette={MOON_PALETTE}
          size={60}
          className="absolute top-[26px] right-[60px] animate-hb-flicker"
        />
        <div aria-hidden className="absolute inset-x-0 bottom-0 h-[62px] border-t-[6px] border-line-2 bg-line" />

        <div className="absolute top-[34px] left-9 flex max-w-[470px] flex-col gap-2.5">
          <h1 className="m-0 font-pixel text-[34px] font-bold text-moonlight">{greeting()}</h1>
          <p className="m-0 text-[17px] leading-normal">{summary(crew.length, busy.length, hobs[0])}</p>
          <div className="flex gap-2 pt-1">
            <Chip>{hobs.length === 1 ? "1 hob" : `${hobs.length} hobs`}</Chip>
            <Chip className={busy.length > 0 ? "text-mint" : ""}>{busy.length} working</Chip>
            <Chip>0 need you</Chip>
          </div>
        </div>

        <div className="absolute right-[150px] bottom-[34px] flex items-end gap-11">
          {crew.slice(0, SCENE_LIMIT).map(({ hob, state }) => (
            <Link
              key={hob.id}
              to="/hobs/$hobId"
              params={{ hobId: hob.id }}
              aria-label={`Open chat with ${hob.name}, ${stateLabel[state]}`}
              className="hop-on-hover flex flex-col items-center gap-1.5 text-ground no-underline"
            >
              <span className="bg-text px-2 py-[3px] text-xs whitespace-nowrap">{sceneTag(hob, state)}</span>
              <HobSprite hob={hob} size={64} state={state} />
            </Link>
          ))}
        </div>
      </section>

      <div className="grid min-h-0 flex-1 grid-cols-[1.15fr_1fr_0.9fr] gap-[18px] px-6 py-5">
        <Card label="Needs you" className="border-[3px] border-lantern" labelClass="text-lantern">
          <p className="m-0 border-t-2 border-line pt-3 leading-normal text-secondary-text">
            Nothing needs you right now. When a hob asks permission or has a question, it waits here and you can answer
            in place.
          </p>
        </Card>

        <div className="flex min-w-0 flex-col gap-[18px]">
          <Card
            label="Happening now"
            extra={
              busy.length > 0 && (
                <>
                  <span aria-hidden className="size-2 animate-hb-blink bg-rose" />
                  <span className="text-xs text-secondary-text">live</span>
                </>
              )
            }
          >
            {busy.length === 0 ? (
              <p className="m-0 text-sm text-secondary-text">All quiet. Your hobs are resting.</p>
            ) : (
              <HappeningNow recent={recent} activity={activity} />
            )}
          </Card>
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
              When hobs share work, each Quest shows here with who is on it and how far it got. Quests arrive with the
              MVP.
            </p>
          </Card>
        </div>
      </div>
    </main>
  );
}

const summary = (count: number, busy: number, first: Agent | undefined) => {
  if (count === 0 || !first) return "No hobs yet.";
  if (count === 1)
    return busy > 0 ? `${first.name} is working on a reply for you.` : `${first.name} is ready when you are.`;
  return busy > 0
    ? `${busy} of your ${count} hobs are working right now.`
    : `Your ${count} hobs are ready when you are.`;
};

const sceneTag = (hob: Agent, state: HobState) =>
  state === "working" ? "Writing…" : state === "thinking" ? "Thinking…" : `${hob.craft} · ready`;

function Chip({ children, className }: { children: React.ReactNode; className?: string }) {
  return <span className={cn("bg-deep px-2.5 py-1 text-[13px] text-text", className)}>{children}</span>;
}

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

function HappeningNow({
  recent,
  activity,
}: {
  recent: ReadonlyArray<{ hob: Agent; thread: Thread }>;
  activity: ActivityMap;
}) {
  return recent
    .filter(({ thread }) => activity[thread.id])
    .map(({ hob, thread }) => (
      <Link
        key={thread.id}
        to="/hobs/$hobId/threads/$threadId"
        params={{ hobId: hob.id, threadId: thread.id }}
        className="flex animate-hb-in items-center gap-2.5 text-text no-underline"
      >
        <HobSprite hob={hob} size={26} state="working" />
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
