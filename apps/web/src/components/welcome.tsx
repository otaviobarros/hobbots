import { Button } from "@hobbots/ui/components/button";
import { PixelArt } from "@hobbots/ui/components/pixel-art";
import { cn } from "@hobbots/ui/lib/utils";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { type CSSProperties, useEffect, useRef, useState } from "react";
import { setupQuery, useUpdateSetup } from "../api/setup.ts";
import { MOON, MOON_PALETTE } from "../art/icons.ts";
import { FIREFLIES, HOUSES, INTRO_MS, intro, PROVIDERS, SCENE_HOBS, type SceneHob } from "../art/village.ts";
import { HobSprite } from "./hob-sprite.tsx";
import { Stars } from "./scene.tsx";

const WATCH_SETUP_MS = 3000;
const GREETING_MS = 1400;

// The intro plays once per launch; coming back to Welcome from setup shows the village at rest.
let introPlayed = false;

/**
 * Welcome, the first screen of a new installation: the night village, Get started into setup,
 * and "I already use Hobbots" to skip it and open Home. Every animation stops with Reduce motion
 * (styles.css), and the scene is drawn at rest then.
 */
export function Welcome() {
  const navigate = useNavigate();
  const update = useUpdateSetup();
  // Setup may finish in another window or on another device; Home opens once it has.
  const setup = useQuery({ ...setupQuery, refetchInterval: WATCH_SETUP_MS, refetchOnWindowFocus: true });
  const completedElsewhere = setup.data?.completed === true;
  useEffect(() => {
    if (completedElsewhere) void navigate({ to: "/" });
  }, [completedElsewhere, navigate]);

  const [playIntro] = useState(() => !introPlayed);
  useEffect(() => {
    if (!playIntro) return;
    const done = setTimeout(() => {
      introPlayed = true;
    }, INTRO_MS);
    return () => clearTimeout(done);
  }, [playIntro]);
  // Intro animations run only on the first visit; the idle loop always runs.
  const introClass = (className: string) => (playIntro ? className : undefined);
  const introDelay = (seconds: number): CSSProperties | undefined =>
    playIntro ? { animationDelay: `${seconds}s` } : undefined;

  const skipSetup = () => update.mutate({ completed: true }, { onSuccess: () => navigate({ to: "/" }) });

  return (
    <main className="relative flex min-h-0 flex-1 flex-col items-center overflow-hidden bg-ground">
      <div aria-hidden className="absolute inset-x-0 bottom-[350px] h-[120px] bg-panel" />
      <div aria-hidden className="absolute inset-x-0 bottom-[270px] h-[120px] bg-card" />
      <Stars count={50} height={330} />
      <span
        aria-hidden
        className="absolute top-[60px] right-[11%] h-[3px] w-14 animate-hb-shoot bg-moonlight opacity-0"
      />
      <PixelArt
        rows={MOON}
        palette={MOON_PALETTE}
        size={84}
        className="absolute top-14 right-[150px] animate-hb-flicker"
      />

      <div className="relative z-10 flex flex-col items-center gap-3.5 px-6 pt-[70px] text-center">
        <h1 className="m-0 font-pixel text-[92px] leading-none font-bold tracking-[0.02em] text-moonlight">
          <span className="sr-only">Hobbots</span>
          {intro.title.map(({ letter, delay }) => (
            <span
              key={delay}
              aria-hidden
              className={cn("inline-block", introClass("animate-hb-drop"))}
              style={introDelay(delay)}
            >
              {letter}
            </span>
          ))}
        </h1>
        <p className={cn("m-0 text-xl", introClass("animate-hb-rise"))} style={introDelay(intro.tagline)}>
          Little helpers that do your chores while you sleep.
        </p>
        <div
          className={cn("flex flex-wrap justify-center gap-3.5 pt-3.5", introClass("animate-hb-rise"))}
          style={introDelay(intro.actions)}
        >
          <Button asChild className="px-[26px] py-3.5 text-[17px] text-ground no-underline hover:text-ground">
            {/* A plain hash link until Where Hobbots runs (#66) registers `setup/where`; then a typed Link. */}
            <a href="#/setup/where">Get started</a>
          </Button>
          <Button
            variant="outline"
            onClick={skipSetup}
            disabled={update.isPending}
            className="bg-ground/60 px-[22px] py-3 text-base"
          >
            I already use Hobbots
          </Button>
        </div>
        {update.isError && (
          <span role="alert" className="bg-ground px-2 text-sm text-rose">
            Hobbots could not save that. Try again in a moment.
          </span>
        )}
      </div>

      <div aria-hidden className="absolute inset-x-0 bottom-0 h-[250px] border-t-8 border-line-2 bg-line" />
      <div aria-hidden className="absolute inset-x-0 bottom-[120px] h-[26px] bg-line-2" />

      {HOUSES.map((house) => (
        <div
          key={house.left}
          aria-hidden
          className="absolute bottom-[146px] bg-[#3d2f52]"
          style={{ left: `${house.left}%`, width: house.width, height: house.height }}
        >
          <div
            className="absolute -inset-x-4 bg-[#5b3f5e] [clip-path:polygon(50%_0,100%_100%,0_100%)]"
            style={{ top: -house.roof, height: house.roof }}
          />
          <div className="absolute right-6 w-5 bg-[#4a3a6a]" style={{ top: -house.chimney, height: house.chimney }} />
          {house.smoke.map((delay, i) => (
            <span
              key={delay}
              className={cn(
                "absolute animate-hb-smoke bg-[#6a6390] opacity-0",
                i === 0 ? "right-7 size-2.5" : "right-[26px] size-2",
              )}
              style={{ top: -house.chimney - 14, animationDelay: `${delay}s` }}
            />
          ))}
          {house.lights.map((delay, i) => (
            <span
              key={delay}
              className={cn(
                "absolute top-[30px] h-[30px] w-[34px] bg-lantern",
                i === 0 ? "left-[22px]" : "right-[22px]",
                introClass("animate-hb-light"),
              )}
              style={introDelay(delay)}
            />
          ))}
          <span className="absolute bottom-0 left-1/2 -ml-[18px] h-[52px] w-9 bg-[#241c33]" />
        </div>
      ))}

      {FIREFLIES.map((fly) => (
        <span
          key={`${fly.left}.${fly.bottom}`}
          aria-hidden
          className="absolute size-1 animate-hb-firefly bg-moonlight"
          style={{ left: `${fly.left}%`, bottom: fly.bottom, animationDelay: `${fly.delay}s` }}
        />
      ))}

      <div className="absolute bottom-[132px] left-[40%] flex items-end gap-10">
        {SCENE_HOBS.map((hob) => (
          <VillageHob key={hob.name} hob={hob} walkIn={playIntro} />
        ))}
      </div>

      <div
        className={cn(
          "absolute inset-x-0 bottom-9 flex flex-wrap items-center justify-center gap-2.5 px-6",
          introClass("animate-hb-rise"),
        )}
        style={introDelay(intro.providers)}
      >
        <span className="text-sm text-secondary-text">Works with the AI you already use</span>
        <ul className="m-0 flex list-none flex-wrap justify-center gap-2.5 p-0">
          {PROVIDERS.map((provider) => (
            <li key={provider} className="border-2 border-line-2 bg-ground px-2.5 py-1 text-[13px]">
              {provider}
            </li>
          ))}
        </ul>
      </div>
    </main>
  );
}

/** A hob strolling in the village: it walks in with the intro, bobs, hops on hover and says hi when clicked. */
function VillageHob({ hob, walkIn }: { hob: SceneHob; walkIn: boolean }) {
  // Counts clicks, so each one restarts the hop and the greeting; 0 when the hob is quiet.
  const [greeted, setGreeted] = useState(0);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const greet = () => {
    setGreeted((n) => n + 1);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setGreeted(0), GREETING_MS);
  };

  return (
    <div
      className={walkIn ? "animate-hb-walk" : undefined}
      style={walkIn ? { animationDelay: `${hob.walk}s` } : undefined}
    >
      <button
        type="button"
        onClick={greet}
        aria-label={`Say hi to ${hob.name}`}
        className="hop-on-hover relative block cursor-pointer border-0 bg-transparent p-0"
      >
        {greeted > 0 && (
          <span
            key={greeted}
            aria-hidden
            className="absolute -top-[38px] left-1/2 -ml-8 w-16 animate-hb-say bg-text py-1 text-center text-[13px] font-bold text-ground"
          >
            {hob.greeting}
          </span>
        )}
        <span key={greeted} className={cn("block", greeted > 0 && "animate-hb-hop")}>
          {/* The bobs start apart, so the three hobs never move in step. */}
          <span className="block animate-hb-bob" style={{ animationDelay: `${hob.bob}s` }}>
            <HobSprite hob={hob} size={72} />
          </span>
        </span>
      </button>
    </div>
  );
}
