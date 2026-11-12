import type { TaskId, ThreadId } from "@hobbots/domain";
import { Button } from "@hobbots/ui/components/button";
import { Textarea } from "@hobbots/ui/components/textarea";
import type { FormEvent } from "react";
import { restoreDraft, sendable, useDraft, writeDraft } from "../../api/drafts.ts";
import { useSendPrompt } from "../../api/queries.ts";
import { enterSends } from "../quest/enter-sends.ts";
import { messages } from "./messages.ts";

const copy = messages.sheet;

/**
 * The box at the quest thread's end: a message to the lead about the quest, sent to the chat it
 * belongs to. Its draft is kept outside the sheet (ADR 016), so going to the Workbench, back to the
 * camp or closing the sheet keeps what was typed. It clears as it is sent, so anything typed while it
 * goes stays, and a refused send puts its text back in front.
 */
export function QuestComposer({
  threadId,
  questId,
  leadName,
}: {
  threadId: ThreadId;
  questId: TaskId;
  leadName: string;
}) {
  const place = `quest-${questId}` as const;
  const text = useDraft(place);
  const send = useSendPrompt(threadId);
  const submit = () => {
    const content = sendable(text);
    if (content === "" || send.isPending) return;
    writeDraft(place, "");
    // The send's own promise puts the text back, so a refusal that comes after the sheet closed
    // still restores it, as the chat's composer does.
    void send.mutateAsync(content).catch(() => restoreDraft(place, content));
  };
  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    submit();
  };
  const label = copy.compose({ name: leadName });
  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-1.5">
      <span className="flex items-end gap-2">
        <Textarea
          aria-label={label}
          placeholder={label}
          rows={2}
          value={text}
          onChange={(event) => writeDraft(place, event.target.value)}
          onKeyDown={enterSends(submit)}
          className="min-h-0 flex-1"
        />
        <Button type="submit" size="sm" disabled={text.trim() === "" || send.isPending}>
          {send.isPending ? copy.sending : copy.send}
        </Button>
      </span>
      <span className="text-meta text-label">{copy.composeHint}</span>
      {send.isError && (
        <p role="alert" className="m-0 text-meta text-rose">
          {copy.sendFailed}
        </p>
      )}
    </form>
  );
}
