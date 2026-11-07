import { Button } from "@hobbots/ui/components/button";
import { Textarea } from "@hobbots/ui/components/textarea";
import { useId, useState } from "react";

/**
 * A hob's draft to change before you take it, as a share's page or a proposed skill: the text, a
 * line on what happens to it, the button that takes it, and Back, which leaves it as the hob wrote it.
 */
export function DraftForm({
  initial,
  label,
  hint,
  submit,
  back,
  rows,
  code = false,
  busy,
  onSubmit,
  onBack,
  onChange,
}: {
  initial: string;
  label: string;
  hint: string;
  submit: string;
  back: string;
  rows: number;
  /** Whether the draft is a file whose lines matter, shown in a monospace face. */
  code?: boolean;
  busy: boolean;
  onSubmit: (draft: string) => void;
  onBack: () => void;
  /** Told of each change to the draft, as when what was said of an earlier one no longer holds. */
  onChange?: (draft: string) => void;
}) {
  const [draft, setDraft] = useState(initial);
  const fieldId = useId();
  return (
    <form
      className="flex flex-col gap-2 rounded-card border-(length:--edge) border-control bg-card p-3"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit(draft);
      }}
    >
      <label htmlFor={fieldId} className="text-detail text-text-secondary">
        {label}
      </label>
      <Textarea
        id={fieldId}
        variant="deep"
        rows={rows}
        text={code ? "mono" : "body"}
        value={draft}
        onChange={(event) => {
          setDraft(event.target.value);
          onChange?.(event.target.value);
        }}
      />
      <span className="text-meta text-label">{hint}</span>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={busy || draft.trim() === ""}>
          {submit}
        </Button>
        <Button type="button" variant="ghost" onClick={onBack} disabled={busy}>
          {back}
        </Button>
      </div>
    </form>
  );
}
