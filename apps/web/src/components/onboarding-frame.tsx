import { useState } from "react";
import { ChiefMark } from "./chief-mark.tsx";
import { Stars } from "./scene.tsx";

export const SETUP_STEPS = ["Providers", "First hob", "Safety", "Folders", "Ready"] as const;

/**
 * The frame every onboarding step shares: the Elder Hob guiding from the left with what is done
 * so far, the step list on top of the right side and the step's own content below it.
 */
export function OnboardingFrame({
  step,
  guide,
  sofar,
  children,
  footer,
}: {
  /** The current step, counting from 0. */
  step: number;
  /** What the Elder Hob says on this step. */
  guide: string;
  sofar: ReadonlyArray<string>;
  children: React.ReactNode;
  footer: React.ReactNode;
}) {
  const [looks, setLooks] = useState(0);
  return (
    <div className="flex min-h-0 flex-1">
      <aside className="relative w-[420px] flex-none overflow-hidden border-r-4 border-line bg-panel">
        <Stars count={22} height={420} />
        <div aria-hidden className="absolute inset-x-0 bottom-0 h-[150px] bg-[#221d44]" />
        <div aria-hidden className="absolute inset-x-0 bottom-[150px] h-2 bg-line" />

        <div className="absolute top-7 left-7 flex items-center gap-2.5">
          <span className="font-pixel text-[22px] font-bold text-moonlight">Hobbots</span>
          <span className="text-[13px] text-label">
            Step {step + 1} of {SETUP_STEPS.length}
          </span>
        </div>
        <div aria-hidden className="absolute top-16 left-7 flex gap-1">
          {SETUP_STEPS.map((name, i) => (
            <span
              key={name}
              className={`h-2 w-[66px] ${i < step ? "bg-mint" : i === step ? "bg-lantern" : "bg-line"}`}
            />
          ))}
        </div>

        <div
          key={guide}
          aria-live="polite"
          className="cut absolute inset-x-7 top-[118px] min-h-[150px] animate-hb-in bg-text px-5 py-[18px] text-[17px] leading-normal text-ground"
        >
          <span className="mb-1.5 block font-pixel text-sm font-bold tracking-[.08em] text-[#5b4f9a] uppercase">
            Elder Hob
          </span>
          {guide}
        </div>
        <div
          aria-hidden
          className="absolute top-[266px] left-[150px] size-0 border-x-[14px] border-t-[16px] border-x-transparent border-t-text"
        />

        <button
          type="button"
          onClick={() => setLooks((n) => n + 1)}
          aria-label="Elder Hob"
          className="absolute bottom-[150px] left-[106px] cursor-pointer border-0 bg-transparent p-0"
        >
          <ChiefMark size={140} mood="working" looks={looks} />
        </button>

        {sofar.length > 0 && (
          <div className="absolute inset-x-7 bottom-[26px] flex flex-col gap-1.5">
            <span className="font-pixel text-sm font-bold tracking-[.08em] text-label uppercase">So far</span>
            {sofar.map((line) => (
              <span key={line} className="animate-hb-in text-sm text-secondary-text">
                <span className="font-bold text-mint">✓</span> {line}
              </span>
            ))}
          </div>
        )}
      </aside>

      <main className="flex min-w-0 flex-1 flex-col bg-ground px-10 pt-[26px] pb-[22px]">
        <ol aria-label="Setup steps" className="m-0 mb-[22px] flex list-none items-center p-0">
          {SETUP_STEPS.map((name, i) => {
            const done = i < step;
            const current = i === step;
            return (
              <li key={name} className={`flex items-center ${i < SETUP_STEPS.length - 1 ? "flex-1" : ""}`}>
                <span
                  aria-current={current ? "step" : undefined}
                  className={`flex items-center gap-2 p-1 ${current ? "text-moonlight" : done ? "text-text" : "text-label"}`}
                >
                  <span
                    className={`cut grid size-7 place-items-center font-pixel text-[15px] font-bold ${done ? "bg-mint text-ground" : current ? "bg-lantern text-ground" : "bg-line-2 text-text"}`}
                  >
                    {done ? "✓" : i + 1}
                  </span>
                  <span className="text-sm font-bold">{name}</span>
                </span>
                {i < SETUP_STEPS.length - 1 && (
                  <span aria-hidden className={`mx-2.5 h-1 flex-1 ${done ? "bg-mint" : "bg-line"}`} />
                )}
              </li>
            );
          })}
        </ol>
        <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
        <div className="flex items-center gap-3 border-t-2 border-line pt-4">{footer}</div>
      </main>
    </div>
  );
}
