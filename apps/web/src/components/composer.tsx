import { Button } from "@hobbots/ui/components/button";

/**
 * A paused hob takes no new work. In a thread the composer queues messages until the hob wakes,
 * with Wake beside it; a new thread waits for Wake. While a reply runs, Send queues the message
 * behind it (CH-008).
 */
export interface PausedHob {
  readonly name: string;
  readonly waking: boolean;
  readonly onWake: () => void;
  /** False before the thread exists: a paused hob starts no new thread. */
  readonly canQueue: boolean;
}

export function Composer({
  placeholder,
  draft,
  onDraft,
  busy,
  stopping,
  sending,
  onSend,
  onStop,
  paused,
}: {
  placeholder: string;
  draft: string;
  onDraft: (draft: string) => void;
  busy: boolean;
  /** Stop was pressed and the reply has not ended yet. */
  stopping: boolean;
  sending: boolean;
  onSend: (content: string) => void;
  onStop: () => void;
  paused?: PausedHob | undefined;
}) {
  const submit = () => {
    const content = draft.trim();
    if (!content || sending || (paused && !paused.canQueue)) return;
    onSend(content);
  };

  return (
    <div className="flex flex-none flex-col gap-1.5 px-6 pt-2 pb-3.5">
      <div className="flex items-end gap-2.5">
        <textarea
          aria-label={placeholder}
          value={draft}
          rows={1}
          disabled={paused !== undefined && !paused.canQueue}
          placeholder={
            paused && !paused.canQueue
              ? `${paused.name} is paused. Wake ${paused.name} to start a thread.`
              : placeholder
          }
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
          <Button variant="deny" onClick={onStop} disabled={stopping} className="px-4 py-[9px]">
            {stopping ? "Stopping…" : "■ Stop"}
          </Button>
        )}
        {paused && (
          <Button variant={paused.canQueue ? "outline" : "default"} onClick={paused.onWake} disabled={paused.waking}>
            Wake {paused.name}
          </Button>
        )}
        {(!paused || paused.canQueue) && (
          <Button onClick={submit} disabled={!draft.trim() || sending}>
            {paused ? "Queue" : "Send"}
          </Button>
        )}
      </div>
      <span className="text-xs text-label">
        {busy
          ? stopping
            ? "Stopping this reply. What was written so far is kept."
            : "Stop ends this reply only. Messages you send now wait their turn."
          : paused
            ? paused.canQueue
              ? `${paused.name} is paused. Messages you queue wait until you wake ${paused.name}.`
              : `Paused hobs take no new work. Your draft stays here until you wake ${paused.name}.`
            : "Enter sends · Shift+Enter adds a line · Hobs have no tools in this build yet"}
      </span>
    </div>
  );
}
