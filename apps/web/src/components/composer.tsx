import { Button } from "@hobbots/ui/components/button";

export function Composer({
  placeholder,
  draft,
  onDraft,
  busy,
  sending,
  onSend,
  onStop,
}: {
  placeholder: string;
  draft: string;
  onDraft: (draft: string) => void;
  busy: boolean;
  sending: boolean;
  onSend: (content: string) => void;
  onStop: () => void;
}) {
  const submit = () => {
    const content = draft.trim();
    if (!content || busy || sending) return;
    onSend(content);
  };

  return (
    <div className="flex flex-none flex-col gap-1.5 px-6 pt-2 pb-3.5">
      <div className="flex items-end gap-2.5">
        <textarea
          aria-label={placeholder}
          value={draft}
          rows={1}
          placeholder={placeholder}
          onChange={(event) => onDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              submit();
            }
          }}
          className="field-sizing-content max-h-40 min-h-[47px] flex-1 resize-none border-2 border-control bg-deep px-3.5 py-[11px] text-text placeholder:text-label"
        />
        {busy && (
          <Button variant="deny" onClick={onStop} className="px-4 py-[9px]">
            ■ Stop
          </Button>
        )}
        <Button onClick={submit} disabled={!draft.trim() || busy || sending}>
          Send
        </Button>
      </div>
      <span className="text-xs text-label">
        {busy
          ? "Stop ends this reply only. What was written so far is kept."
          : "Enter sends · Shift+Enter adds a line · Hobs have no tools in this build yet"}
      </span>
    </div>
  );
}
