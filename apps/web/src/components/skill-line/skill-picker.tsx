import { Button } from "@hobbots/ui/components/button";
import { cn } from "@hobbots/ui/lib/utils";
import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import { MemoryIcon } from "../memory/memory-parts.tsx";
import { messages } from "./messages.ts";
import {
  dismissedDraft,
  matchingSkills,
  pickedDraft,
  type SkillPicking,
  slashQuery,
  startedDraft,
} from "./skill-picker-model.ts";

const copy = messages.picker;

/** A key pressed with Shift, Alt, Command or Control, which the list leaves to the input. */
const modified = (event: KeyboardEvent) => event.shiftKey || event.altKey || event.metaKey || event.ctrlKey;

/**
 * Picking one of the hob's skills with `/` (ADR 029, Explicit use): while the draft is `/` and the
 * start of a name, the list shows the skills that match; ↑ and ↓ move, Enter or a click picks, and
 * Escape closes the list. The picked skill becomes `/name ` at the start of the message, which the
 * hub hands the runtime as its own mention; what was already written stays after it. `write` takes
 * the new draft and where the cursor goes in it.
 */
export const useSkillPicker = (
  draft: string,
  picking: SkillPicking | undefined,
  write: (draft: string, cursor: number) => void,
) => {
  const [active, setActive] = useState(0);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const slash =
    picking === undefined
      ? null
      : slashQuery(
          draft,
          picking.skills.map((skill) => skill.name),
        );
  const open = slash !== null && dismissed !== draft;
  const list = open && picking ? matchingSkills(picking.skills, slash.query) : [];
  const at = Math.min(active, Math.max(0, list.length - 1));
  const pick = (name: string) => {
    write(pickedDraft(name, slash?.rest ?? null), name.length + 2);
    setActive(0);
  };
  /** Use a skill: a `/` at the start, before what was written, with the cursor after it. */
  const start = () => {
    setDismissed(null);
    write(startedDraft(draft), 1);
  };
  /**
   * Handles a key for the list; true when it took the key. It takes only the plain keys it names:
   * Shift+Enter still adds a line, Shift+Tab still moves focus back, and a modified arrow still moves
   * through the text.
   */
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (!open || modified(event)) return false;
    if (event.key === "Escape") {
      const back = slash === null ? draft : dismissedDraft(draft, slash);
      if (back === draft) setDismissed(draft);
      else write(back, 0);
      return true;
    }
    if (list.length === 0) return false;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      const step = event.key === "ArrowDown" ? 1 : -1;
      setActive((at + step + list.length) % list.length);
      return true;
    }
    if (event.key === "Enter" || event.key === "Tab") {
      const chosen = list[at];
      if (chosen) pick(chosen.name);
      return true;
    }
    return false;
  };
  /**
   * The input's key handler with the list's keys first: a key the list takes goes no further, and
   * one an IME is composing with is left to the IME.
   */
  const around =
    (rest: (event: KeyboardEvent<HTMLTextAreaElement>) => void) => (event: KeyboardEvent<HTMLTextAreaElement>) => {
      const composing = event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229;
      if (!composing && onKeyDown(event)) {
        event.preventDefault();
        return;
      }
      rest(event);
    };
  return { open, list, active: at, pick, around, start };
};

/** The `/` list over the composer, as the screens draw it. */
export function SkillPickerList({
  picking,
  picker,
}: {
  picking: SkillPicking | undefined;
  picker: ReturnType<typeof useSkillPicker>;
}) {
  const list = useRef<HTMLUListElement>(null);
  // The highlighted skill stays in view as ↑ and ↓ move through a list longer than the space it has.
  useEffect(() => {
    if (picker.open) list.current?.children[picker.active]?.scrollIntoView({ block: "nearest" });
  }, [picker.open, picker.active]);
  if (picking === undefined || !picker.open) return null;
  const empty = picking.skills.length === 0;
  return (
    <section
      aria-label={copy.label({ name: picking.hobName })}
      className="flex animate-hb-in flex-col gap-1 rounded-card border border-line-2 bg-card p-2"
    >
      <span className="px-2 py-1 text-meta text-label">{copy.heading({ name: picking.hobName })}</span>
      {/* At most a third of the window, so the conversation keeps its room; the rest scrolls. */}
      <ul ref={list} className="m-0 flex max-h-[33vh] list-none flex-col overflow-y-auto p-0">
        {picker.list.map((skill, index) => (
          <li key={skill.name}>
            <button
              type="button"
              aria-current={index === picker.active ? "true" : undefined}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => picker.pick(skill.name)}
              className={cn(
                "flex w-full cursor-pointer items-center gap-2.5 rounded-control border-0 px-2.5 py-2 text-start font-[inherit] text-text-strong hover:bg-hover",
                index === picker.active ? "bg-hover" : "bg-transparent",
              )}
            >
              <code className="flex-none text-detail text-link">/{skill.name}</code>
              <span className="min-w-0 flex-1 truncate">{skill.title}</span>
              <span className="text-meta whitespace-nowrap text-label">{skill.sub}</span>
            </button>
          </li>
        ))}
      </ul>
      {picker.list.length === 0 && <EmptyList picking={picking} empty={empty} />}
      <span className="px-2 pt-1 pb-0.5 text-meta text-label">{copy.hint({ name: picking.hobName })}</span>
    </section>
  );
}

/** What the list says when it shows no skill: still loading, failed with a retry, or none to show. */
function EmptyList({ picking, empty }: { picking: SkillPicking; empty: boolean }) {
  const name = picking.hobName;
  if (picking.status === "failed") {
    return (
      <span role="alert" className="flex items-center gap-2 px-2.5 py-2 text-detail text-text-secondary">
        {copy.failed({ name })}
        <Button variant="outline" size="bar" onMouseDown={(event) => event.preventDefault()} onClick={picking.onRetry}>
          {copy.retry}
        </Button>
      </span>
    );
  }
  const text =
    picking.status === "loading" ? copy.loading({ name }) : empty ? copy.noSkills({ name }) : copy.none({ name });
  return (
    <span aria-live="polite" className="px-2.5 py-2 text-detail text-text-secondary">
      {text}
    </span>
  );
}

/** The wand and sparkles the screens use for skills. */
export function SkillIcon({ size = 14 }: { size?: number }) {
  return <MemoryIcon name="skill" size={size} />;
}

/** The composer's button that starts a `/`, as typing it does; none while there is nothing to pick from. */
export function UseSkillButton({
  picking,
  hidden,
  onClick,
}: {
  picking: SkillPicking | undefined;
  /** While the composer is closed, as for a paused hob's new thread. */
  hidden: boolean;
  onClick: () => void;
}) {
  if (picking === undefined || hidden) return null;
  return (
    <Button
      variant="quiet"
      size="icon"
      aria-label={copy.useSkill}
      title={copy.useSkill}
      onClick={onClick}
      className="-ms-2"
    >
      <SkillIcon size={16} />
    </Button>
  );
}
