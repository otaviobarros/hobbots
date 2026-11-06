import { Button } from "@hobbots/ui/components/button";
import { Textarea } from "@hobbots/ui/components/textarea";
import { cn } from "@hobbots/ui/lib/utils";
import { Link } from "@tanstack/react-router";
import { useId } from "react";
import { messages } from "./messages.ts";
import { descriptionState, type SkillsView, skillsSearchOf } from "./skills-model.ts";

const copy = messages;

const HINT = {
  short: copy.editor.descriptionShort,
  long: copy.editor.descriptionLong,
  good: copy.editor.descriptionGood,
} as const;

/** When to use it: what a hob reads before it picks the skill, checked as you type. */
export function DescriptionField({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const id = useId();
  const hintId = useId();
  const state = descriptionState(value);
  return (
    <label htmlFor={id} className="flex flex-col gap-1.5 text-detail text-label">
      {copy.editor.description}
      <Textarea
        id={id}
        rows={2}
        value={value}
        aria-describedby={hintId}
        aria-invalid={state === "long"}
        onChange={(event) => onChange(event.target.value)}
      />
      <span id={hintId} className={cn("flex gap-2", state === "good" ? "text-label" : "text-lantern")}>
        <span className="flex-1">{HINT[state]}</span>
        <span className="tabular-nums">{copy.editor.descriptionCount({ count: value.trim().length })}</span>
      </span>
    </label>
  );
}

/** The instructions: the SKILL.md text after its front matter, in a mono box. */
export function InstructionsField({
  value,
  onChange,
  rows,
}: {
  value: string;
  onChange: (value: string) => void;
  rows: number;
}) {
  const id = useId();
  return (
    <label htmlFor={id} className="flex flex-col gap-1.5 text-detail text-label">
      {copy.editor.instructions}
      <Textarea id={id} rows={rows} text="mono" value={value} onChange={(event) => onChange(event.target.value)} />
      <span>{copy.editor.instructionsHint}</span>
    </label>
  );
}

/** Under the editor: what went wrong if Save failed, Save itself, Cancel, and what Save checks. */
export function EditorFooter({
  failure,
  saveLabel,
  disabled,
  back,
}: {
  failure: string | null;
  saveLabel: string;
  disabled: boolean;
  back: SkillsView;
}) {
  return (
    <>
      {failure !== null && (
        <p role="alert" className="m-0 rounded-card bg-notice px-3.5 py-2.5 text-ui text-text-strong">
          {failure}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" disabled={disabled}>
          {saveLabel}
        </Button>
        <Button asChild variant="quiet">
          <Link to="/skills" search={skillsSearchOf(back)}>
            {copy.editor.cancel}
          </Link>
        </Button>
        <span className="ms-auto text-meta text-label">{copy.editor.checked}</span>
      </div>
    </>
  );
}
