import { HOB_COLORS } from "@hobbots/art/look";
import type { Agent } from "@hobbots/domain";
import { Badge } from "@hobbots/ui/components/badge";
import { Button } from "@hobbots/ui/components/button";
import { cn } from "@hobbots/ui/lib/utils";
import { Link } from "@tanstack/react-router";
import type { CSSProperties } from "react";
import type { HobState } from "../../lib/hob-state.ts";
import { HobSprite } from "../hob-sprite/hob-sprite.tsx";
import { type Doing, stateTag } from "./hob-page-model.ts";
import { messages } from "./messages.ts";

const copy = messages;

// The hob's hat color tints the hero and its ground strip (`--hob`), mixed with theme tokens so it
// reads in every theme. The strip is two tones of pixel ground, 8px each.
const heroStyle = (hob: Agent): CSSProperties =>
  ({
    "--hob": HOB_COLORS[hob.lookColor].hat,
    backgroundImage:
      "linear-gradient(180deg, color-mix(in srgb, var(--hob) 26%, var(--color-card)) 0%, var(--color-card) 78%)",
  }) as CSSProperties;

const groundStyle: CSSProperties = {
  backgroundImage:
    "repeating-linear-gradient(90deg, color-mix(in srgb, var(--hob) 55%, var(--color-deep)) 0 8px, color-mix(in srgb, var(--hob) 40%, var(--color-deep)) 8px 16px)",
  boxShadow: "inset 0 2px 0 color-mix(in srgb, var(--hob) 70%, var(--color-card))",
};

/**
 * The top of a hob's page: the hob standing on its ground strip, its name and state tag, role and a
 * quiet stats line, a speech bubble with what it is doing, then New chat and Profile.
 */
export function HobHero({
  hob,
  state,
  stats,
  doing,
  fresh,
}: {
  hob: Agent;
  state: HobState;
  stats: string;
  doing: Doing | null;
  /** A hob with no chats yet, whose tag says New. */
  fresh: boolean;
}) {
  return (
    <section aria-label={hob.name} className="cut relative overflow-hidden px-6 pt-6" style={heroStyle(hob)}>
      <div className="relative flex flex-wrap items-end gap-5">
        <span className="relative flex h-[120px] w-[112px] flex-none items-end justify-center">
          <span
            aria-hidden
            className="absolute inset-x-[18px] bottom-0.5 h-2.5 rounded-[50%] bg-[color-mix(in_srgb,var(--hob)_35%,var(--color-deep))]"
          />
          <HobSprite hob={hob} size={98} state={state} className="z-[1] mb-1.5" />
        </span>
        <div className="flex min-w-0 flex-[1_1_340px] flex-col gap-1.5 pb-[18px]">
          <span className="flex min-w-0 items-center gap-2.5">
            <h1
              title={hob.name}
              className="m-0 min-w-0 truncate font-(family-name:--font-heading) text-[32px] leading-[38px] font-(--heading-weight) [font-variant-ligatures:none]"
            >
              {hob.name}
            </h1>
            <HobStateTag state={state} fresh={fresh} />
          </span>
          <span
            title={copy.roleStats({ role: hob.roleTitle, stats })}
            className="truncate text-[15px] text-text-secondary"
          >
            {hob.roleTitle}
            <span className="text-label"> · {stats}</span>
          </span>
          {doing && <DoingBubble doing={doing} />}
        </div>
        <div className="flex flex-none items-center gap-2 pb-[18px]">
          <Button asChild>
            <Link to="/hobs/$hobId/new" params={{ hobId: hob.id }} aria-label={copy.newChatWith({ name: hob.name })}>
              <span aria-hidden>+</span>
              {copy.newChat}
            </Link>
          </Button>
          <Button asChild variant="outline">
            <Link to="/hobs/$hobId/profile" params={{ hobId: hob.id }}>
              {copy.profile}
            </Link>
          </Button>
        </div>
      </div>
      <div aria-hidden className="relative -mx-6 h-2.5" style={groundStyle} />
    </section>
  );
}

/** A hob's state as a tag: the family's glyph, so it reads without color, and its word. */
export function HobStateTag({ state, fresh = false }: { state: HobState; fresh?: boolean }) {
  const tag = stateTag(state, fresh);
  return (
    <Badge variant={tag.variant}>
      <span aria-hidden data-slot="badge-glyph">
        {tag.glyph}
      </span>
      {tag.word}
    </Badge>
  );
}

/** The speech bubble: lantern-tinted with a link to the Inbox when the hob needs you, else what it does. */
function DoingBubble({ doing }: { doing: Doing }) {
  const needs = doing.kind === "needs-you";
  return (
    <span
      className={cn(
        "flex max-w-full items-center gap-2 self-start rounded-xl rounded-ss-[2px] px-3 py-[7px] text-sm",
        needs ? "bg-[color-mix(in_srgb,var(--color-lantern)_18%,var(--color-deep))] text-text-strong" : "bg-deep",
      )}
    >
      {doing.kind === "live" && (
        <span role="img" aria-label={copy.doing.live} className="size-2 flex-none rounded-(--corner-dot) bg-mint" />
      )}
      <span title={doing.text} className="line-clamp-2 min-w-0">
        {doing.text}
      </span>
      {needs && (
        <Link to="/inbox" className="flex-none font-semibold text-lantern no-underline hover:text-lantern-hover">
          {copy.doing.seeWhat} <span aria-hidden>→</span>
        </Link>
      )}
    </span>
  );
}
