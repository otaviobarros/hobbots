import type { Agent } from "@hobbots/domain";
import { focusElement, focusedElement } from "@hobbots/ui/lib/restore-focus";
import { cn } from "@hobbots/ui/lib/utils";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { useFirstRunTheme } from "../../lib/theme.ts";
import { ChiefMark } from "../chief/chief-mark.tsx";
import { HobSprite } from "../hob-sprite/hob-sprite.tsx";
import { messages } from "../messages.ts";
import { Stars } from "../scene/scene.tsx";

const copy = messages.onboarding.frame;

type SpriteHob = Pick<Agent, "lookSeed" | "lookColor"> & Partial<Pick<Agent, "hat" | "tool" | "sigil">>;

/** One line of the preview's summary: a step of setup and what was picked there, once it is done. */
export interface SummaryLine {
  readonly label: string;
  readonly value: string | null;
}

/** The little AI tag over the preview's sky: whether setup has found the AI and connected it. */
export interface PreviewChip {
  readonly label: string;
  readonly tone: "looking" | "found" | "connected" | "problem";
}

/** What the preview beside a step shows, as the choices so far build up the scene. */
export interface Preview {
  readonly caption?: string | undefined;
  readonly chip?: PreviewChip | undefined;
  /** The first hob, or "ghost" for the silhouette before it has a shape. */
  readonly hob?: (SpriteHob & { readonly name: string; readonly title: string }) | "ghost" | undefined;
  /** The hub's house, on Where Hobbots runs. */
  readonly house?: boolean | undefined;
  /** How high the safety fence stands, from 0 (none) to 1 (Careful). */
  readonly fence?: number | undefined;
  readonly folders?: number | undefined;
  /** The phone that can visit, once other devices may connect. */
  readonly phone?: boolean | undefined;
  /** What the Chief says. */
  readonly speech: string;
  /** What setup has settled so far; left out on the steps before it starts. */
  readonly summary?: ReadonlyArray<SummaryLine> | undefined;
}

const CHIP_DOT: Record<PreviewChip["tone"], string> = {
  looking: "bg-line-2",
  found: "bg-line-2",
  connected: "bg-provider-claude",
  problem: "bg-rose",
};

/** The night scene in the preview: the Chief, then the AI, the hob, its fence, folders and phone. */
function PreviewScene({ preview }: { preview: Preview }) {
  const [looks, setLooks] = useState(0);
  const { chip, hob, fence = 0, folders = 0 } = preview;
  const connected = chip?.tone === "connected";
  return (
    <div className="relative h-[200px] overflow-hidden rounded-control bg-[linear-gradient(180deg,var(--color-deep)_0%,var(--color-ground)_60%,var(--color-scene-ground)_100%)]">
      <Stars count={14} height={140} />
      <span aria-hidden className="absolute top-3 end-3.5 size-[18px] rounded-full bg-star" />
      <span
        aria-hidden
        className="absolute inset-x-0 bottom-0 h-[30px] border-t-3 border-scene-chimney bg-scene-ground"
      />
      {connected && (
        <span
          aria-hidden
          className="absolute top-[60px] start-[46px] size-[76px] animate-hb-glow rounded-full bg-[radial-gradient(closest-side,color-mix(in_srgb,var(--color-lantern)_55%,transparent),transparent)]"
        />
      )}
      <button
        type="button"
        aria-label={copy.chief}
        onClick={() => setLooks((n) => n + 1)}
        className="absolute bottom-[30px] start-2.5 cursor-pointer border-0 bg-transparent p-0"
      >
        <ChiefMark size={80} mood="working" looks={looks} />
      </button>
      {preview.house && <House />}
      {chip && (
        <span
          className={cn(
            // standards-allow STD-I18N-004: left-1/2 with -translate-x-1/2 centers the box, and translate has no logical form
            "absolute top-3 left-1/2 inline-flex -translate-x-1/2 animate-hb-pop items-center gap-1.5 rounded-full border border-scene-chimney bg-deep px-2.5 py-0.5 text-meta whitespace-nowrap text-text-strong",
            connected && "shadow-[0_0_12px_color-mix(in_srgb,var(--color-lantern)_45%,transparent)]",
          )}
        >
          <span aria-hidden className={cn("size-2 rounded-full", CHIP_DOT[chip.tone])} />
          {chip.label}
        </span>
      )}
      {hob === "ghost" && (
        <span aria-hidden className="absolute bottom-[30px] start-[128px] grid size-[70px] place-items-end opacity-80">
          <span className="mx-auto mb-1 h-[52px] w-10 rounded-t-[14px] bg-line-2" />
          <span className="absolute inset-x-0 bottom-6 text-center text-lg font-bold text-label">?</span>
        </span>
      )}
      {hob && hob !== "ghost" && (
        <span aria-hidden className="absolute bottom-[30px] start-[128px] animate-hb-pop">
          <HobSprite hob={hob} size={70} badge className="animate-hb-bob" />
        </span>
      )}
      {fence > 0 && (
        <span
          aria-hidden
          className="absolute bottom-[30px] start-[102px] w-28 bg-[repeating-linear-gradient(90deg,var(--color-wood)_0_5px,transparent_5px_11px)] transition-[height] duration-(--dur-sheet) ease-(--ease-ui)"
          style={{ height: Math.round(12 + fence * 22) }}
        />
      )}
      {Array.from({ length: Math.min(folders, 2) }, (_, i) => (
        <span
          // The folders only ever grow or shrink at the end, so their place is their key.
          // biome-ignore lint/suspicious/noArrayIndexKey: fixed places in the scene
          key={i}
          aria-hidden
          className="absolute bottom-[30px] h-[18px] w-6 animate-hb-pop rounded-[2px] bg-lantern"
          style={{ left: 222 + i * 28 }}
        />
      ))}
      {preview.phone && (
        <span
          aria-hidden
          className="absolute top-[34px] start-[246px] h-[27px] w-[18px] animate-hb-pop rounded-[3px] border-3 border-text-strong bg-deep shadow-[0_0_6px_var(--color-star)]"
        />
      )}
    </div>
  );
}

/** The hub's house beside the Chief, with its windows lit. */
function House() {
  return (
    <span aria-hidden className="absolute bottom-[30px] start-[132px] flex animate-hb-pop flex-col items-center">
      <span className="size-0 border-x-[40px] border-b-[30px] border-x-transparent border-b-scene-roof" />
      <span className="flex h-[50px] w-16 items-start justify-center gap-3 bg-scene-wall pt-2.5">
        <span className="size-3 bg-lantern" />
        <span className="size-3 bg-lantern" />
      </span>
    </span>
  );
}

/** The preview beside every setup step: the scene, the hob taking shape, the Chief and what is settled. */
function PreviewPanel({ preview }: { preview: Preview }) {
  const hob = preview.hob && preview.hob !== "ghost" ? preview.hob : null;
  return (
    <aside
      aria-label={copy.preview}
      className="sticky top-0 flex w-[300px] flex-none flex-col gap-3 self-start rounded-card bg-card p-4 max-lg:hidden"
    >
      <span className="lbl text-center text-label">{copy.preview}</span>
      <PreviewScene preview={preview} />
      {preview.caption && <span className="text-center text-detail text-text-secondary">{preview.caption}</span>}
      {hob && (
        <span className="flex flex-col items-center gap-1 text-center">
          <strong className="max-w-full truncate font-heading text-title font-bold text-moonlight">{hob.name}</strong>
          {hob.title && (
            <span className="max-w-full truncate rounded-tag bg-line-2 px-2 py-0.5 text-detail font-bold">
              {hob.title}
            </span>
          )}
        </span>
      )}
      <div className="flex items-start gap-2.5">
        <span aria-hidden className="grid size-9 flex-none place-items-center rounded-control bg-deep">
          <ChiefMark size={30} />
        </span>
        <span className="flex min-w-0 flex-col gap-1">
          <span className="text-meta text-label">{copy.chief}</span>
          <span
            key={preview.speech}
            aria-live="polite"
            className="animate-hb-in rounded-[2px_12px_12px_12px] bg-text-strong px-3 py-2.5 text-ui leading-5 text-ground"
          >
            {preview.speech}
          </span>
        </span>
      </div>
      {preview.summary && (
        <ul aria-label={copy.soFar} className="m-0 flex list-none flex-col gap-1 border-line border-t pt-2.5 ps-0">
          {preview.summary.map((line) => (
            <li key={line.label} className="flex gap-2 text-detail leading-[18px]">
              <span aria-hidden className={cn("w-3", line.value ? "text-mint" : "text-label")}>
                {line.value ? "✓" : "·"}
              </span>
              <span className="w-24 flex-none text-label">{line.label}</span>
              <span className={cn("truncate", line.value ? "text-text-strong" : "text-label")}>
                {line.value ?? (
                  <>
                    <span aria-hidden>—</span>
                    <span className="sr-only">{copy.notYet}</span>
                  </>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
    </aside>
  );
}

/** The steps along the top: done ones ticked, the current one lit. */
function Stepper({ step }: { step: number }) {
  return (
    <ol aria-label={copy.steps} className="m-0 flex list-none gap-2 p-0">
      {copy.stepNames.map((name, i) => {
        const done = i < step;
        const current = i === step;
        return (
          <li
            key={name}
            className={cn(
              "flex min-w-0 flex-1 border-b-3 pb-1.5",
              done ? "border-moonlight" : current ? "border-lantern" : "border-line",
            )}
          >
            <span
              aria-current={current ? "step" : undefined}
              className={cn(
                "flex min-w-0 items-center gap-2 px-2 py-1.5 text-ui",
                current || done ? "text-text-strong" : "text-text-secondary",
              )}
            >
              <span
                aria-hidden
                className={cn(
                  "grid size-[22px] flex-none place-items-center rounded-full text-meta font-bold",
                  done ? "bg-moonlight text-ground" : current ? "bg-lantern text-on-lantern" : "bg-line-2",
                )}
              >
                {done ? "✓" : i + 1}
              </span>
              <span className="truncate">{name}</span>
            </span>
          </li>
        );
      })}
    </ol>
  );
}

/**
 * How tall the step's sticky footer is, so the scroller keeps that much room at its bottom and a
 * field that takes focus is never hidden under the footer (WCAG 2.4.11). It follows the footer as
 * its buttons wrap.
 */
const useFooterClearance = () => {
  const [footer, setFooter] = useState<HTMLElement | null>(null);
  const [height, setHeight] = useState(0);
  useEffect(() => {
    if (footer === null) return;
    const measure = () => setHeight(footer.offsetHeight);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(footer);
    return () => observer.disconnect();
  }, [footer]);
  return { footer: setFooter, height };
};

/**
 * Each setup step opens at the top, and when the step before it took the focus away with it, focus
 * moves to the new step's heading, so a keyboard user starts there and not on the page (WCAG 2.4.3).
 * A field the step focuses by itself keeps the focus.
 */
const useStepHeadingFocus = () => {
  const scroller = useRef<HTMLElement>(null);
  useEffect(() => {
    if (focusedElement() !== null) return;
    const heading = scroller.current?.querySelector<HTMLElement>("h1");
    if (heading) focusElement(heading);
  }, []);
  return scroller;
};

/**
 * The frame every setup step shares, always in Workshop Night: what stage of setup this is and the
 * steps along the top, the step's own content with its footer, and the preview beside it, where the
 * Chief talks and the scene builds up with each choice.
 */
export function OnboardingFrame({
  step,
  extra = false,
  preview,
  children,
  footer,
}: {
  /** The current step, counting from 0; null on the steps before setup's five, such as Where. */
  step: number | null;
  /** An optional step between two of the five, such as other devices. */
  extra?: boolean;
  /** Left out while a step fills the whole width, as the summoning does. */
  preview?: Preview | undefined;
  children: ReactNode;
  footer: ReactNode;
}) {
  useFirstRunTheme();
  const scroller = useStepHeadingFocus();
  const clearance = useFooterClearance();
  const stage =
    step === null
      ? copy.stage
      : extra
        ? copy.stageExtra
        : copy.stageStep({ step: step + 1, of: copy.stepNames.length });
  return (
    <main
      ref={scroller}
      aria-label={copy.stage}
      className="min-h-0 flex-1 overflow-y-auto bg-ground"
      style={{ scrollPaddingBottom: clearance.height }}
    >
      <div className="mx-auto box-border flex min-h-full max-w-[1040px] flex-col gap-[22px] px-10 pt-7 max-md:px-4">
        <header className="flex flex-col gap-3.5">
          <span className="lbl text-label">{stage}</span>
          {step !== null && <Stepper step={step} />}
        </header>
        <div className="flex grow items-stretch gap-8">
          <div className="flex min-w-0 flex-1 flex-col gap-4">
            <div className="animate-hb-in">{children}</div>
            {footer && (
              <footer
                ref={clearance.footer}
                className="sticky bottom-0 z-[2] mt-auto flex flex-wrap items-center gap-2 bg-ground pt-3.5 pb-6"
              >
                {footer}
              </footer>
            )}
          </div>
          {preview && <PreviewPanel preview={preview} />}
        </div>
      </div>
    </main>
  );
}
