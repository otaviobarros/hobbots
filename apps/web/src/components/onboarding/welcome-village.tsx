import { PixelArt } from "@hobbots/ui/components/pixel-art";
import { cn } from "@hobbots/ui/lib/utils";
import { type CSSProperties, type ReactNode, useEffect, useRef, useState } from "react";
import { intro, PROVIDERS, SCENE_HOBS, type SceneHob } from "../../art/village.ts";
import { WELCOME_SCENE, WELCOME_SCENE_PALETTE, WELCOME_TITLE, WELCOME_TITLE_PALETTE } from "../../art/welcome-scene.ts";
import { useFirstRunTheme } from "../../lib/theme.ts";
import { ChiefMark } from "../chief/chief-mark.tsx";
import { HobSprite } from "../hob-sprite/hob-sprite.tsx";
import { messages } from "../messages.ts";
import { VillageLights } from "./village-lights.tsx";

const GREETING_MS = 1400;

// The intro plays once per launch; coming back to Welcome from setup shows the village at rest.
let introPlayed = false;

/** The classes of Welcome's two actions: Get started, and the quieter second one. */
export const welcomeActionClass = {
  primary: "px-[26px] py-3.5 text-[17px] text-ground no-underline hover:text-ground",
  secondary: "px-[22px] py-3 text-base text-text-secondary hover:text-text-strong",
};

/** The scene's own size: everything in it is placed in these pixels, then scaled to cover the window. */
const STAGE = { width: 1280, height: 800 };

/**
 * Scales the 1280 × 800 scene to cover the window, standing on its bottom edge and centered, so
 * the village always reaches the edges and the sky gives way first on a short window.
 */
const useCoverStage = () => {
  const [frame, setFrame] = useState<HTMLElement | null>(null);
  const [fit, setFit] = useState({ scale: 1, left: 0, top: 0 });
  useEffect(() => {
    if (frame === null) return;
    const measure = () => {
      const { clientWidth: width, clientHeight: height } = frame;
      const scale = Math.max(width / STAGE.width, height / STAGE.height);
      setFit({ scale, left: (width - STAGE.width * scale) / 2, top: height - STAGE.height * scale });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(frame);
    return () => observer.disconnect();
  }, [frame]);
  const style: CSSProperties = {
    width: STAGE.width,
    height: STAGE.height,
    transform: `translate(${fit.left}px, ${fit.top}px) scale(${fit.scale})`,
  };
  return { frame: setFrame, style };
};

/**
 * Welcome's night village, the first screen of a new installation, around its `actions`: Get started
 * into setup, and a second way in. The village is the README banner's world at full size, with the
 * Chief and the hobs standing in it. Every animation stops with Reduce motion (styles.css), and the
 * scene is drawn at rest then. The hub's pages and setup's local pages each give their own actions.
 */
export function WelcomeVillage({
  actions,
  more,
  alert,
}: {
  actions: ReactNode;
  /** A quieter way in under the time line, such as restoring a backup. */
  more?: ReactNode;
  alert?: string | undefined;
}) {
  useFirstRunTheme();
  const [playIntro] = useState(() => !introPlayed);
  useEffect(() => {
    introPlayed = true;
  }, []);
  const stage = useCoverStage();
  // Intro animations run only on the first visit; the idle motion plays on every visit, then settles.
  const introClass = (className: string) => (playIntro ? className : undefined);
  const introDelay = (seconds: number): CSSProperties | undefined =>
    playIntro ? { animationDelay: `${seconds}s` } : undefined;

  return (
    <main ref={stage.frame} className="relative flex min-h-0 flex-1 flex-col items-center overflow-hidden bg-deep">
      <div className="absolute top-0 start-0 origin-top-left" style={stage.style}>
        <PixelArt
          rows={WELCOME_SCENE}
          palette={WELCOME_SCENE_PALETTE}
          size={STAGE.width}
          className="absolute inset-0"
        />
        <VillageLights playIntro={playIntro} />
        <span
          aria-hidden
          className="absolute top-[430px] start-[630px] size-[140px] animate-hb-flicker rounded-full bg-[radial-gradient(closest-side,color-mix(in_srgb,var(--color-lantern-hover)_55%,transparent),color-mix(in_srgb,var(--color-lantern)_18%,transparent)_55%,transparent)]"
        />
        <span aria-hidden className="absolute top-[480px] start-[560px]">
          <ChiefMark size={160} mood="working" />
        </span>
        <span className="absolute top-[420px] start-[736px] max-w-[220px] rounded-[12px_12px_12px_2px] bg-text-strong px-3 py-2.5 text-start text-ui leading-5 text-ground">
          {messages.welcome.chiefHello}
        </span>
        {SCENE_HOBS.map((hob) => (
          <span key={hob.name} className="absolute top-[556px]" style={{ left: hob.left }}>
            <VillageHob hob={hob} walkIn={playIntro} />
          </span>
        ))}
      </div>

      <div className="relative z-10 flex flex-col items-center gap-3 px-6 pt-10 text-center">
        <h1 className={cn("m-0", introClass("animate-hb-drop"))} style={introDelay(intro.title)}>
          <span className="sr-only">Hobbots</span>
          <PixelArt
            aria-hidden
            rows={WELCOME_TITLE}
            palette={WELCOME_TITLE_PALETTE}
            size={672}
            className="block h-auto max-w-[calc(100vw-48px)]"
          />
        </h1>
        <p
          className={cn(
            "m-0 max-w-[560px] pt-3 text-[21px] leading-[30px] text-text-strong",
            introClass("animate-hb-rise"),
          )}
          style={introDelay(intro.tagline)}
        >
          {messages.welcome.tagline}
        </p>
        <div
          className={cn("flex flex-wrap justify-center gap-2.5 pt-2.5", introClass("animate-hb-rise"))}
          style={introDelay(intro.actions)}
        >
          {actions}
        </div>
        <span className="text-detail text-label">{messages.welcome.duration}</span>
        {more}
        {alert !== undefined && (
          <span role="alert" className="bg-ground px-2 text-ui text-rose">
            {alert}
          </span>
        )}
      </div>

      <div
        className={cn(
          "absolute inset-x-0 bottom-[22px] flex flex-wrap items-center justify-center gap-2.5 px-6",
          introClass("animate-hb-rise"),
        )}
        style={introDelay(intro.providers)}
      >
        <span className="text-detail text-label">
          {messages.welcome.worksWith({ providers: PROVIDERS.join(" · ") })}
        </span>
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
        aria-label={messages.welcome.sayHi({ name: hob.name })}
        className="hop-on-hover relative block cursor-pointer border-0 bg-transparent p-0"
      >
        {greeted > 0 && (
          <span
            key={greeted}
            aria-hidden
            className="absolute -top-[38px] start-1/2 -ms-8 w-16 animate-hb-say bg-text-strong py-1 text-center text-detail font-bold text-ground"
          >
            {hob.greeting}
          </span>
        )}
        <span key={greeted} className={cn("block", greeted > 0 && "animate-hb-hop")}>
          {/* The bobs start apart, so the three hobs never move in step. */}
          <span className="block animate-hb-bob" style={{ animationDelay: `${hob.bob}s` }}>
            <HobSprite hob={hob} size={84} />
          </span>
        </span>
      </button>
    </div>
  );
}
