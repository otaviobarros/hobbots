import { MOON, MOON_PALETTE } from "@hobbots/art/moon";
import { PixelArt } from "@hobbots/ui/components/pixel-art";
import { cn } from "@hobbots/ui/lib/utils";
import { type CSSProperties, type ReactNode, useEffect, useRef, useState } from "react";
import { FIREFLIES, HOUSES, intro, PROVIDERS, SCENE_HOBS, type SceneHob } from "../../art/village.ts";
import { useFirstRunTheme } from "../../lib/theme.ts";
import { ChiefMark } from "../chief/chief-mark.tsx";
import { HobSprite } from "../hob-sprite/hob-sprite.tsx";
import { Stars } from "../scene/scene.tsx";

const GREETING_MS = 1400;

// The intro plays once per launch; coming back to Welcome from setup shows the village at rest.
let introPlayed = false;

/** The classes of Welcome's two actions: Get started, and the quieter second one. */
export const welcomeActionClass = {
  primary: "px-[26px] py-3.5 text-[17px] text-ground no-underline hover:text-ground",
  secondary: "px-[22px] py-3 text-base text-text-secondary hover:text-text-strong",
};

/**
 * Welcome's night village, the first screen of a new installation, around its `actions`: Get started
 * into setup, and a second way in. Every animation stops with Reduce motion (styles.css), and the
 * scene is drawn at rest then. The hub's pages and setup's local pages each give their own actions.
 */
export function WelcomeVillage({
  actions,
  more,
  alert,
}: {
  actions: ReactNode;
  /** A quieter way in under the actions, such as restoring a backup. */
  more?: ReactNode;
  alert?: string | undefined;
}) {
  useFirstRunTheme();
  const [playIntro] = useState(() => !introPlayed);
  useEffect(() => {
    introPlayed = true;
  }, []);
  // Intro animations run only on the first visit; the idle loop always runs.
  const introClass = (className: string) => (playIntro ? className : undefined);
  const introDelay = (seconds: number): CSSProperties | undefined =>
    playIntro ? { animationDelay: `${seconds}s` } : undefined;

  return (
    <main className="relative flex min-h-0 flex-1 flex-col items-center overflow-hidden bg-ground">
      <div aria-hidden className="absolute inset-x-0 bottom-[350px] h-[120px] bg-panel" />
      <div aria-hidden className="absolute inset-x-0 bottom-[270px] h-[120px] bg-card" />
      <Stars count={50} height={330} />
      <span
        aria-hidden
        className="absolute top-[60px] end-[11%] h-[3px] w-14 animate-hb-shoot bg-moonlight opacity-0"
      />
      <PixelArt
        rows={MOON}
        palette={MOON_PALETTE}
        size={84}
        className="absolute top-14 end-[150px] animate-hb-flicker"
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
          Little helpers that work on your computer, with the AI you already use.
        </p>
        <div
          className={cn("flex flex-wrap justify-center gap-3.5 pt-3.5", introClass("animate-hb-rise"))}
          style={introDelay(intro.actions)}
        >
          {actions}
        </div>
        <span className="text-[13px] text-text-secondary">About 3 minutes. Everything stays on your computer.</span>
        {more}
        {alert !== undefined && (
          <span role="alert" className="bg-ground px-2 text-sm text-rose">
            {alert}
          </span>
        )}
      </div>

      <div aria-hidden className="absolute inset-x-0 bottom-0 h-[250px] border-t-8 border-line-2 bg-line" />
      <div aria-hidden className="absolute inset-x-0 bottom-[120px] h-[26px] bg-line-2" />

      {HOUSES.map((house) => (
        <div
          key={house.left}
          aria-hidden
          className="absolute bottom-[146px] bg-scene-wall"
          style={{ left: `${house.left}%`, width: house.width, height: house.height }}
        >
          <div
            className="absolute -inset-x-4 bg-scene-roof [clip-path:polygon(50%_0,100%_100%,0_100%)]"
            style={{ top: -house.roof, height: house.roof }}
          />
          <div className="absolute end-6 w-5 bg-scene-chimney" style={{ top: -house.chimney, height: house.chimney }} />
          {house.smoke.map((delay, i) => (
            <span
              key={delay}
              className={cn(
                "absolute animate-hb-smoke bg-scene-smoke opacity-0",
                i === 0 ? "end-7 size-2.5" : "end-[26px] size-2",
              )}
              style={{ top: -house.chimney - 14, animationDelay: `${delay}s` }}
            />
          ))}
          {house.lights.map((delay, i) => (
            <span
              key={delay}
              className={cn(
                "absolute top-[30px] h-[30px] w-[34px] bg-lantern",
                i === 0 ? "start-[22px]" : "end-[22px]",
                introClass("animate-hb-light"),
              )}
              style={introDelay(delay)}
            />
          ))}
          <span className="absolute bottom-0 start-1/2 -ms-[18px] h-[52px] w-9 bg-scene-door" />
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

      {/* standards-allow STD-I18N-004: left-1/2 with -translate-x-1/2 centers the box, and translate has no logical form */}
      <div className="absolute bottom-[132px] left-1/2 flex -translate-x-1/2 items-end gap-10">
        {SCENE_HOBS.slice(0, 2).map((hob) => (
          <VillageHob key={hob.name} hob={hob} walkIn={playIntro} />
        ))}
        <span className="relative flex flex-col items-center">
          <span className="absolute bottom-full start-[70%] mb-1 w-[230px] rounded-[12px_12px_12px_2px] bg-text-strong/85 px-3 py-2 text-start text-sm leading-5 text-ground">
            Welcome! I'm the Chief. I'll help you set up your first hob.
          </span>
          <ChiefMark size={150} mood="working" />
        </span>
        {SCENE_HOBS.slice(2).map((hob) => (
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
        <span className="text-[13px] text-text-secondary">Works with {PROVIDERS.join(" · ")}</span>
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
            className="absolute -top-[38px] start-1/2 -ms-8 w-16 animate-hb-say bg-text-strong py-1 text-center text-[13px] font-bold text-ground"
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
