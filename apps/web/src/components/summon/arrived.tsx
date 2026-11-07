import { HOB_COLORS } from "@hobbots/art/look";
import type { Agent, AgentId } from "@hobbots/domain";
import { Button } from "@hobbots/ui/components/button";
import { Skeleton } from "@hobbots/ui/components/skeleton";
import { useQuery } from "@tanstack/react-query";
import { Link, Navigate } from "@tanstack/react-router";
import { writeDraft } from "../../api/drafts.ts";
import { agentsQuery } from "../../api/queries.ts";
import { HobSprite } from "../hob-sprite/hob-sprite.tsx";
import { messages as skillsCopy } from "../hob-skills/messages.ts";
import { messages } from "./messages.ts";
import { startersFor } from "./summon-model.ts";

const copy = messages.arrived;

/** Where each twinkle sits on the stage, and its size: two full stars and two small ones. */
const TWINKLES = [
  "top-9 left-[70px] size-3.5",
  "top-6 right-[78px] size-3.5 [animation-delay:0.6s]",
  "top-24 left-24 size-2.5 [animation-delay:1.2s]",
  "top-22 right-16 size-[11px] [animation-delay:1.8s]",
];

/** The Arrived screen for a hob by its id; a hob that is gone opens its page, which says so. */
export function ArrivedPage({ hobId, skillsNotGiven = false }: { hobId: AgentId; skillsNotGiven?: boolean }) {
  const hobs = useQuery(agentsQuery);
  const hob = hobs.data?.find((h) => h.id === hobId);
  if (hobs.isPending) return <ArrivedWaiting />;
  if (!hob) return <Navigate to="/hobs/$hobId" params={{ hobId }} replace />;
  return <Arrived hob={hob} skillsNotGiven={skillsNotGiven} />;
}

/**
 * The end of Summon: the new hob on its own little stage, three first questions for its role, and
 * the ways on: its chat, its profile, or another summon. A question opens the chat with it typed in,
 * ready to send or change. Long names wrap in the words and shorten on the buttons.
 */
function Arrived({ hob, skillsNotGiven }: { hob: Agent; skillsNotGiven: boolean }) {
  const name = hob.name;
  const place = `new-${hob.id}` as const;
  return (
    <main aria-label={copy.title({ name })} className="flex min-w-0 flex-1 flex-col overflow-y-auto">
      <div className="mx-auto flex w-full max-w-[640px] animate-hb-in flex-col items-center gap-4 px-6 py-14 text-center">
        <Stage hob={hob} />
        <h1 className="m-0 max-w-full font-heading text-display font-(--heading-weight) break-words">
          {copy.title({ name })}
        </h1>
        <p className="m-0 max-w-full text-text-secondary break-words">{copy.body({ name, role: hob.roleTitle })}</p>
        {skillsNotGiven && (
          <p role="status" className="m-0 w-full rounded-card bg-notice px-3.5 py-2.5 text-start text-ui text-text-strong">
            {skillsCopy.summon.notGiven({ name })}{" "}
            <Link to="/hobs/$hobId" params={{ hobId: hob.id }} search={{ tab: "skills" }} className="text-link underline">
              {skillsCopy.summon.openTab}
            </Link>
          </p>
        )}

        <section aria-labelledby="arrived-ask" className="flex w-full flex-col gap-2 pt-2 text-start">
          <h2 id="arrived-ask" className="lbl m-0 text-label">
            {copy.tryAsking}
          </h2>
          <ul className="m-0 flex list-none flex-col overflow-hidden rounded-card bg-card p-0">
            {startersFor(hob.role).map((question) => (
              <li key={question} className="border-line not-first:border-t">
                <Link
                  to="/hobs/$hobId/new"
                  params={{ hobId: hob.id }}
                  onClick={() => writeDraft(place, question)}
                  className="flex items-center gap-3 px-3.5 py-3 text-text-strong no-underline transition-colors duration-(--dur-fade) hover:bg-hover focus-ring focus-inset"
                >
                  <AskIcon />
                  <span className="min-w-0 flex-1">{question}</span>
                  <span aria-hidden className="text-text-secondary">
                    →
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>

        <div className="flex max-w-full flex-wrap justify-center gap-2 pt-2">
          <Button asChild className="max-w-[320px]">
            <Link to="/hobs/$hobId/new" params={{ hobId: hob.id }}>
              <span className="truncate">{copy.chat({ name })}</span>
            </Link>
          </Button>
          <Button asChild variant="outline" className="max-w-[280px]">
            <Link to="/hobs/$hobId/profile" params={{ hobId: hob.id }}>
              <span className="truncate">{copy.profile({ name })}</span>
            </Link>
          </Button>
          <SummonAnother />
        </div>
      </div>
    </main>
  );
}

/**
 * The little stage the hob stands on, lit in its hat color. Before the hob is read, the stage is lit
 * in the line color, with a tile where the hob stands.
 */
function Stage({ hob }: { hob: Agent | undefined }) {
  const hobColor = hob === undefined ? "var(--color-line)" : HOB_COLORS[hob.lookColor].hat;
  return (
    <span
      className="relative flex h-45 w-80 max-w-full items-end justify-center overflow-hidden rounded-card bg-[linear-gradient(180deg,color-mix(in_srgb,var(--hob)_26%,var(--color-ground))_0%,color-mix(in_srgb,var(--hob)_10%,var(--color-ground))_100%)]"
      style={{ "--hob": hobColor } as React.CSSProperties}
    >
      <span
        aria-hidden
        // standards-allow STD-I18N-004: left-1/2 with -translate-x-1/2 centers the box, and translate has no logical form
        className="absolute -top-8 left-1/2 size-65 -translate-x-1/2 rounded-full bg-[radial-gradient(circle,color-mix(in_srgb,var(--hob)_34%,transparent)_0%,transparent_65%)]"
      />
      {TWINKLES.map((spot) => (
        <svg
          key={spot}
          aria-hidden
          viewBox="0 0 10 10"
          className={`absolute z-10 animate-hb-twinkle fill-current text-lantern ${spot}`}
        >
          <path d="M5 0 6 4 10 5 6 6 5 10 4 6 0 5 4 4Z" />
        </svg>
      ))}
      {hob === undefined ? (
        <span className="relative z-[1] mb-2.5">
          <Skeleton shape="tile" className="size-28" />
        </span>
      ) : (
        <span className="relative z-[1] mb-2.5 animate-hb-hop">
          <HobSprite hob={hob} size={112} />
        </span>
      )}
      <span
        aria-hidden
        className="absolute inset-x-0 bottom-0 h-3.5 bg-[repeating-linear-gradient(90deg,color-mix(in_srgb,var(--hob)_55%,var(--color-deep))_0_8px,color-mix(in_srgb,var(--hob)_40%,var(--color-deep))_8px_16px)] shadow-[inset_0_2px_0_color-mix(in_srgb,var(--hob)_70%,var(--color-card))]"
      />
    </span>
  );
}

/** The speech mark before each first question. */
function AskIcon() {
  return (
    <span
      aria-hidden
      className="grid size-7 flex-none place-items-center rounded-control bg-[color-mix(in_srgb,var(--color-star)_18%,transparent)] text-star"
    >
      <svg aria-hidden viewBox="0 0 16 16" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="1.5">
        <path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z" strokeLinejoin="round" />
      </svg>
    </span>
  );
}

/**
 * Arrived while the hobs are read, as after a reload: the stage, the title and the three questions
 * as blocks in their places, so nothing moves when the hob is read. Reads from the hub add no wait line.
 */
export function ArrivedWaiting() {
  return (
    <main aria-busy="true" className="flex min-w-0 flex-1 flex-col overflow-y-auto">
      <div className="mx-auto flex w-full max-w-[640px] flex-col items-center gap-4 px-6 py-14 text-center">
        <Stage hob={undefined} />
        <span className="font-heading text-display">
          <Skeleton width="14ch" />
        </span>
        <span className="flex w-full flex-col items-center">
          <Skeleton width="44ch" className="max-w-full" />
          <Skeleton width="30ch" className="max-w-full" />
        </span>
        <div className="flex w-full flex-col gap-2 pt-2 text-start">
          <span className="lbl text-label">{copy.tryAsking}</span>
          <span className="m-0 flex flex-col overflow-hidden rounded-card bg-card">
            {WAITING_QUESTIONS.map((width) => (
              <span key={width} className="flex items-center gap-3 border-line px-3.5 py-3 not-first:border-t">
                <AskIcon />
                <span className="min-w-0 flex-1">
                  <Skeleton width={width} surface="card" className="max-w-full" />
                </span>
              </span>
            ))}
          </span>
        </div>
        <div className="flex max-w-full flex-wrap justify-center gap-2 pt-2">
          <Skeleton shape="tile" className="h-9 w-56" />
          <Skeleton shape="tile" className="h-9 w-44" />
          <SummonAnother />
        </div>
      </div>
    </main>
  );
}

/** The quiet way back to Summon, for one more hob. */
function SummonAnother() {
  return (
    <Button asChild variant="ghost" className="text-text-secondary">
      <Link to="/summon">{copy.another}</Link>
    </Button>
  );
}

/** The likely length of each first question while the hob is read. */
const WAITING_QUESTIONS = ["30ch", "36ch", "24ch"] as const;
