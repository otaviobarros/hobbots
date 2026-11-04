import { HOB_COLORS } from "@hobbots/art/look";
import type { Agent, Thread } from "@hobbots/domain";
import { cn } from "@hobbots/ui/lib/utils";
import { Link } from "@tanstack/react-router";
import type { CSSProperties } from "react";
import type { ActivityMap } from "../../api/activity.ts";
import { useIsNewHob } from "../../api/history.ts";
import type { HobState } from "../../lib/hob-state.ts";
import { formatWhen } from "../../lib/time.ts";
import { HobStateTag } from "../hob-page/hob-hero.tsx";
import { doingOf, stateTag } from "../hob-page/hob-page-model.ts";
import { HobSprite } from "../hob-sprite/hob-sprite.tsx";
import { cardLine, lastChat } from "./hobs-page-model.ts";
import { messages } from "./messages.ts";

const copy = messages;

// The hob's hat color tints its doorway (`--hob`), mixed with theme tokens so it reads in every theme.
const tint = (hob: Agent): CSSProperties => ({ "--hob": HOB_COLORS[hob.lookColor].hat }) as CSSProperties;

const door =
  "relative flex h-[84px] items-end bg-[linear-gradient(180deg,color-mix(in_srgb,var(--hob)_30%,var(--color-card))_0%,color-mix(in_srgb,var(--hob)_12%,var(--color-card))_100%)] px-4";

const ground =
  "absolute inset-x-0 bottom-0 h-1.5 bg-[repeating-linear-gradient(90deg,color-mix(in_srgb,var(--hob)_50%,var(--color-deep))_0_6px,color-mix(in_srgb,var(--hob)_36%,var(--color-deep))_6px_12px)]";

/**
 * One hob on Your hobs: a little doorway in its hat color with the hob and its state tag, then its
 * name and role, what it is doing and its last chat. A hob that needs you gets a lantern edge.
 */
export function HobCard({
  hob,
  state,
  threads,
  activity,
}: {
  hob: Agent;
  state: HobState;
  threads: ReadonlyArray<Thread>;
  activity: ActivityMap;
}) {
  const doing = doingOf(state, threads, activity);
  const last = lastChat(threads);
  const needs = doing?.kind === "needs-you";
  const fresh = useIsNewHob(hob.id, threads.length);
  return (
    <Link
      to="/hobs/$hobId"
      params={{ hobId: hob.id }}
      aria-label={copy.card.open({ name: hob.name, state: stateTag(state, fresh).word })}
      style={tint(hob)}
      className={cn(
        "hop-on-hover cut relative flex min-w-0 flex-col overflow-hidden bg-card text-text-strong no-underline transition-[translate,box-shadow,background-color] duration-150 hover:-translate-y-0.5 hover:bg-hover hover:text-text-strong hover:shadow-menu focus-ring motion-reduce:transition-none motion-reduce:hover:translate-y-0",
        needs &&
          "shadow-[inset_0_0_0_1.5px_color-mix(in_srgb,var(--color-lantern)_70%,transparent)] hover:shadow-[inset_0_0_0_1.5px_var(--color-lantern),var(--shadow-menu)]",
      )}
    >
      <span className={door}>
        <HobSprite hob={hob} size={64} state={state} className="z-[1] -mb-0.5" />
        <span aria-hidden className={ground} />
        <span className="absolute top-3 end-3">
          <HobStateTag state={state} fresh={fresh} />
        </span>
      </span>
      <span className="flex min-w-0 flex-col gap-2 px-4 pt-3 pb-3.5">
        <span className="flex min-w-0 flex-col">
          <strong title={hob.name} className="truncate font-heading text-lg leading-6 font-(--heading-weight)">
            {hob.name}
          </strong>
          <span title={hob.roleTitle} className="truncate text-[13px] leading-[18px] text-label">
            {hob.roleTitle}
          </span>
        </span>
        <span
          className={cn(
            "flex min-h-10 items-start gap-2 text-sm leading-5",
            needs ? "text-lantern" : "text-text-secondary",
          )}
        >
          {doing?.kind === "live" && (
            <span aria-hidden className="mt-1.5 size-2 flex-none animate-hb-blink rounded-dot bg-mint" />
          )}
          {needs && <span aria-hidden className="mt-1.5 size-2 flex-none rotate-45 rounded-[2px] bg-lantern" />}
          <span className="line-clamp-2 min-w-0">{cardLine(doing, threads, fresh)}</span>
        </span>
        <span className="flex min-w-0 items-center gap-2 border-t border-line pt-2.5 text-[13px] leading-[18px] text-text-secondary">
          <ChatIcon />
          <span className="sr-only">{copy.card.lastChat}</span>
          <span title={last?.title} className="min-w-0 flex-1 truncate">
            {last?.title ?? copy.card.noChats}
          </span>
          {last && <span className="flex-none text-label">{formatWhen(last.updatedAt)}</span>}
        </span>
      </span>
    </Link>
  );
}

function ChatIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="size-4 flex-none"
    >
      <path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z" />
    </svg>
  );
}
