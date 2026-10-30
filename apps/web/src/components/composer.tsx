import { Button } from "@hobbots/ui/components/button";

/** A paused hob takes no new work: the composer keeps the draft and offers Wake instead of Send. */
export interface PausedHob {
  readonly name: string;
  readonly waking: boolean;
  readonly onWake: () => void;
}

export function Composer({
  placeholder,
  draft,
  onDraft,
  busy,
  sending,
  onSend,
  onStop,
  paused,
}: {
  placeholder: string;
  draft: string;
  onDraft: (draft: string) => void;
  busy: boolean;
  sending: boolean;
  onSend: (content: string) => void;
  onStop: () => void;
  paused?: PausedHob | undefined;
}) {
  const submit = () => {
    const content = draft.trim();
    if (!content || busy || sending || paused) return;
    onSend(content);
  };

  return (
    <div className="flex flex-none flex-col gap-1.5 px-6 pt-2 pb-3.5">
      <div className="flex items-end gap-2.5">
        <textarea
          aria-label={placeholder}
          value={draft}
          rows={1}
          disabled={paused !== undefined}
          placeholder={paused ? `${paused.name} is paused. Wake ${paused.name} to send a message.` : placeholder}
          onChange={(event) => onDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              submit();
            }
          }}
          className="field-sizing-content max-h-40 min-h-[47px] flex-1 resize-none border-2 border-control bg-deep px-3.5 py-[11px] text-text placeholder:text-label disabled:cursor-not-allowed disabled:border-line disabled:opacity-70"
        />
        {busy && (
          <Button variant="deny" onClick={onStop} className="px-4 py-[9px]">
            ■ Stop
          </Button>
        )}
        {paused ? (
          <Button onClick={paused.onWake} disabled={paused.waking}>
            Wake {paused.name}
          </Button>
        ) : (
          <Button onClick={submit} disabled={!draft.trim() || busy || sending}>
            Send
          </Button>
        )}
      </div>
      <span className="text-xs text-label">
        {busy
          ? "Stop ends this reply only. What was written so far is kept."
          : paused
            ? `Paused hobs take no new work. Your draft stays here until you wake ${paused.name}.`
            : "Enter sends · Shift+Enter adds a line · Hobs have no tools in this build yet"}
      </span>
    </div>
  );
}
