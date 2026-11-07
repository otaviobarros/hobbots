import type { MemoryScope } from "@hobbots/domain";
import { Input } from "@hobbots/ui/components/input";
import { cn } from "@hobbots/ui/lib/utils";
import { useId } from "react";
import type { EditorDraft } from "./memory-edit-model.ts";
import { type HobDirectory, keptInOf } from "./memory-model.ts";
import { MemoryCard } from "./memory-parts.tsx";
import { messages } from "./messages.ts";

const copy = messages;

/**
 * The editor's side: where the page is kept, and its pin and forget day. Where it is kept does not
 * change here: sharing a page with more hobs is its own step.
 */
export function EditorSettings({
  scope,
  hobs,
  draft,
  today,
  error,
  onChange,
  onBlurDay,
}: {
  scope: MemoryScope;
  hobs: HobDirectory;
  draft: EditorDraft;
  /** `YYYY-MM-DD`, the earliest a forget day may not be. */
  today: string;
  error: string | undefined;
  onChange: (change: Partial<EditorDraft>) => void;
  onBlurDay: () => void;
}) {
  const dayId = useId();
  const hintId = useId();
  return (
    <aside aria-label={copy.editor.settings} className="flex w-[280px] flex-none flex-col gap-4">
      <MemoryCard label={copy.editor.keptIn}>
        <h3 className="lbl m-0 text-label">{copy.editor.keptIn}</h3>
        <span className="text-ui">{keptInOf(scope, hobs)}</span>
      </MemoryCard>
      <MemoryCard label={copy.editor.settings}>
        <label className="flex cursor-pointer items-start gap-2.5">
          <input
            type="checkbox"
            checked={draft.pinned}
            onChange={(event) => onChange({ pinned: event.target.checked })}
            className="mt-[3px] size-4 accent-mint"
          />
          <span className="flex flex-col">
            <span className="text-ui">{copy.editor.pinIt}</span>
            <span className="text-meta text-label">{copy.editor.pinHint}</span>
          </span>
        </label>
        <label htmlFor={dayId} className="text-ui">
          {copy.editor.forgetOn}
        </label>
        <Input
          id={dayId}
          type="date"
          value={draft.forgetOn}
          min={today}
          aria-invalid={error !== undefined}
          aria-describedby={hintId}
          onChange={(event) => onChange({ forgetOn: event.target.value })}
          onBlur={onBlurDay}
        />
        <span id={hintId} className={cn("text-meta", error === undefined ? "text-label" : "text-rose")}>
          {error ?? copy.editor.forgetHint}
        </span>
      </MemoryCard>
    </aside>
  );
}
