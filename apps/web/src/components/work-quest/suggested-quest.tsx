import { START_WORK_TOOL, StartWorkInput } from "@hobbots/domain";
import { Option, Schema } from "effect";
import { messages } from "./messages.ts";

/** A Quest a hob suggests with `start_work` (ADR 041), as its approval request carries it. */
export interface QuestSuggestion {
  readonly title: string;
  readonly goal: string;
  readonly doneWhen: ReadonlyArray<string>;
  readonly expectedBy: string | null;
}

const decodeSuggestion = Schema.decodeUnknownOption(StartWorkInput);

/** The Quest a `start_work` request suggests, or null for any other request or arguments it cannot read. */
export const questSuggestion = (approval: {
  readonly tool: string;
  readonly arguments: Readonly<Record<string, unknown>>;
}): QuestSuggestion | null => {
  if (approval.tool !== START_WORK_TOOL) return null;
  return Option.match(decodeSuggestion(approval.arguments), {
    onNone: () => null,
    onSome: (input) => ({
      title: input.title,
      goal: input.goal,
      doneWhen: input.done_when,
      expectedBy: input.expected_by ?? null,
    }),
  });
};

/**
 * What an Ask for Start a Quest shows (ADR 041): the Quest the hob suggests, with its goal and "Done
 * when" lines, so you see what you start before you allow it.
 */
export function SuggestedQuest({ quest }: { quest: QuestSuggestion }) {
  return (
    <div className="flex flex-col gap-1.5 rounded-card bg-deep px-3 py-2.5">
      <span className="text-meta font-bold tracking-[.06em] text-lantern uppercase">{messages.suggested}</span>
      <span className="font-heading text-title font-(--heading-weight) text-text-strong">{quest.title}</span>
      <span className="text-detail text-text-secondary">{quest.goal}</span>
      <span className="text-meta font-semibold text-label">{messages.doneWhen}</span>
      <ul className="m-0 flex list-none flex-col gap-1 p-0">
        {quest.doneWhen.map((line) => (
          <li key={line} className="flex items-start gap-2 text-detail text-text">
            <span aria-hidden className="mt-1 size-3 shrink-0 rounded-dot border-(length:--edge) border-line-2" />
            {line}
          </li>
        ))}
      </ul>
      {quest.expectedBy !== null && (
        <span className="text-meta text-label">{messages.expectedBy({ day: quest.expectedBy })}</span>
      )}
    </div>
  );
}
