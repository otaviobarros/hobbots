import { type Agent, starterRole } from "@hobbots/domain";
import { Button } from "@hobbots/ui/components/button";
import { cn } from "@hobbots/ui/lib/utils";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { ChiefMark } from "../chief/chief-mark.tsx";
import { HobSprite } from "../hob-sprite/hob-sprite.tsx";
import { messages } from "../messages.ts";
import { RoleSigil } from "../roles/role-sigil.tsx";
import { Stars } from "../scene/scene.tsx";
import { SummoningCircle } from "../summon/summoning.tsx";

const copy = messages.onboarding.ready;

type SpriteHob = Pick<Agent, "lookSeed" | "lookColor"> & Partial<Pick<Agent, "hat" | "tool" | "sigil">>;

/** First run's night scene: the sky, the ground, the Chief on the left and room for the hob. */
function Scene({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        "relative h-[520px] overflow-hidden rounded-card bg-[linear-gradient(180deg,var(--color-deep)_0%,var(--color-ground)_55%,var(--color-scene-ground)_100%)] text-text-strong",
        className,
      )}
    >
      <Stars count={34} height={380} />
      <span
        aria-hidden
        className="absolute inset-x-0 bottom-0 h-[110px] border-t-6 border-scene-chimney bg-scene-ground"
      />
      {children}
    </div>
  );
}

/** A speech bubble, cut after four lines so a long name or role never pushes the scene apart. */
function Bubble({ children, tail }: { children: string; tail: "left" | "right" }) {
  return (
    <span
      title={children}
      className={cn(
        "block w-[230px] max-w-full bg-text-strong px-3 py-2.5 text-ui leading-5 text-ground",
        tail === "right" ? "rounded-[12px_12px_2px_12px]" : "rounded-[12px_12px_12px_2px]",
      )}
    >
      <span className="line-clamp-4">{children}</span>
    </span>
  );
}

/** The Chief calls the first hob: the ring of light opens beside the Chief and the hob appears. */
export function FirstSummoning({ hob, name }: { hob: SpriteHob; name: string }) {
  return (
    <Scene>
      <div aria-hidden className="absolute inset-x-0 bottom-[80px] flex items-end justify-center gap-14 px-4">
        <span className="mb-6">
          <ChiefMark size={160} mood="working" />
        </span>
        <SummoningCircle hob={hob} size={168} className="h-[300px] w-[260px] max-w-[50%]" />
      </div>
      <strong
        role="status"
        className="absolute inset-x-4 bottom-9 text-center font-heading text-heading font-(--heading-weight) break-words"
      >
        {copy.calling({ name })}
      </strong>
    </Scene>
  );
}

/**
 * The end of First run: the Chief welcomes the new hob, the hob says who it is, and the user says
 * hello in its chat or goes Home. Replay plays the summoning again.
 */
export function FirstArrived({ hob, onReplay }: { hob: Agent; onReplay: () => void }) {
  const note = hob.role === null ? "" : starterRole(hob.role).note;
  return (
    <Scene className="animate-hb-in">
      <h1 className="sr-only">{copy.here({ name: hob.name })}</h1>
      <div className="absolute inset-x-0 bottom-[104px] flex items-end justify-center gap-10 px-4">
        <span className="flex min-w-0 flex-col items-center gap-3">
          <Bubble tail="right">{copy.chiefWelcome({ name: hob.name })}</Bubble>
          <ChiefMark size={160} />
        </span>
        <span className="flex min-w-0 flex-col items-center gap-3">
          <Bubble tail="left">{copy.hobHello({ name: hob.name, role: hob.roleTitle, note })}</Bubble>
          {/* The sigil sits on the hob's bottom-left corner, where its feet meet the ground. */}
          <span className="hop-on-hover relative">
            <HobSprite hob={hob} size={168} />
            {hob.sigil && (
              <span
                aria-hidden
                className="absolute -start-1 bottom-1.5 grid size-[34px] place-items-center rounded-tag bg-deep"
              >
                <RoleSigil sigil={hob.sigil} size={26} />
              </span>
            )}
          </span>
        </span>
      </div>
      <div className="absolute inset-x-4 bottom-5 flex flex-col items-center gap-2">
        <span className="flex max-w-full gap-2">
          <Button asChild className="min-w-0 max-w-[280px]">
            <Link to="/hobs/$hobId/new" params={{ hobId: hob.id }}>
              <span className="truncate">{copy.sayHello({ name: hob.name })}</span>
            </Link>
          </Button>
          <Button asChild variant="outline" className="bg-card">
            <Link to="/">{copy.home}</Link>
          </Button>
        </span>
        <Button variant="ghost" size="xs" onClick={onReplay} aria-label={copy.replayLabel} className="text-star">
          <span aria-hidden>▶</span> {copy.replay}
        </Button>
      </div>
    </Scene>
  );
}
