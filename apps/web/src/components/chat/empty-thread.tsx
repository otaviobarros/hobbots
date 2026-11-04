import { HOB_COLORS } from "@hobbots/art/look";
import type { Agent } from "@hobbots/domain";
import type { CSSProperties } from "react";
import { HobSprite } from "../hob-sprite/hob-sprite.tsx";
import { messages } from "../messages.ts";

const copy = messages.chat;

/**
 * An empty thread: the hob on a small stage in its hat color, asking "What are we making?", a
 * heading and a line on how it works, then three starter prompts that fill the composer.
 */
export function EmptyThread({
  hob,
  newHob,
  onIdea,
}: {
  hob: Agent;
  /** A hob with no chats yet says hello instead. */
  newHob: boolean;
  onIdea: (idea: string) => void;
}) {
  return (
    <div className="mx-auto mt-14 flex w-full max-w-[560px] animate-hb-in flex-col items-center gap-3.5 text-center">
      <div
        className="relative flex h-[150px] w-[440px] max-w-full items-end justify-center overflow-hidden rounded-card bg-[linear-gradient(180deg,color-mix(in_srgb,var(--hob)_22%,var(--color-ground))_0%,color-mix(in_srgb,var(--hob)_8%,var(--color-ground))_100%)]"
        style={{ "--hob": HOB_COLORS[hob.lookColor].hat } as CSSProperties}
      >
        <span
          aria-hidden
          // standards-allow STD-I18N-004: left-1/2 with -translate-x-1/2 centers the box, and translate has no logical form
          className="absolute -top-10 left-1/2 size-65 -translate-x-1/2 rounded-full bg-[radial-gradient(circle,color-mix(in_srgb,var(--hob)_32%,transparent)_0%,transparent_65%)]"
        />
        <span className="relative z-[1] mb-2">
          <HobSprite hob={hob} size={84} state="working" />
        </span>
        <span
          aria-hidden
          className="absolute inset-x-0 bottom-0 h-3 bg-[repeating-linear-gradient(90deg,color-mix(in_srgb,var(--hob)_55%,var(--color-deep))_0_8px,color-mix(in_srgb,var(--hob)_40%,var(--color-deep))_8px_16px)] shadow-[inset_0_2px_0_color-mix(in_srgb,var(--hob)_70%,var(--color-card))]"
        />
        <span className="absolute top-[26px] start-[calc(50%+40px)] z-[2] rounded-[12px_12px_12px_2px] bg-card px-3 py-[7px] text-ui leading-5 whitespace-nowrap text-text-strong shadow-menu">
          {copy.askWhat}
        </span>
      </div>
      <h2 className="m-0 mt-1.5 font-heading text-[30px] leading-9 font-(--heading-weight)">
        {newHob ? copy.hello(hob) : copy.freshPage}
      </h2>
      <p className="m-0 max-w-[440px] text-text-secondary">{newHob ? copy.helloBody : copy.freshBody(hob)}</p>
      <div className="mt-1.5 flex flex-wrap justify-center gap-2">
        {copy.ideas.map((idea) => (
          <button
            key={idea}
            type="button"
            onClick={() => onIdea(idea)}
            className="inline-flex cursor-pointer items-center gap-2 rounded-[18px] border border-line-2 bg-card px-3.5 py-2 text-ui leading-5 text-text transition-colors hover:border-lantern hover:text-text-strong"
          >
            <SparkIcon />
            {idea}
          </button>
        ))}
      </div>
    </div>
  );
}

function SparkIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      aria-hidden
      className="text-label"
    >
      <path d="M8 2v3M8 11v3M2 8h3M11 8h3M4 4l1.8 1.8M10.2 10.2 12 12M4 12l1.8-1.8M10.2 5.8 12 4" />
    </svg>
  );
}
