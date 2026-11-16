import { START_WORK_TOOL } from "@hobbots/domain";
import { messages } from "./messages.ts";

/** A Quest a hob suggests with `start_work` (ADR 041), as its approval request carries it. */
export interface QuestSuggestion {
  readonly title: string;
  readonly goal: string;
  readonly doneWhen: ReadonlyArray<string>;
  readonly expectedBy: string | null;
}

const isText = (value: unknown): value is string => typeof value === "string" && value.trim() !== "";

/** The Quest a `start_work` request suggests, or null for any other request or arguments it cannot read. */
export const questSuggestion = (approval: {
  readonly tool: string;
  readonly arguments: Readonly<Record<string, unknown>>;
}): QuestSuggestion | null => {
  if (approval.tool !== START_WORK_TOOL) return null;
  const { title, goal, done_when: doneWhen, expected_by: expectedBy } = approval.arguments;
  if (!isText(title) || !isText(goal) || !Array.isArray(doneWhen) || !doneWhen.every(isText)) return null;
  return { title, goal, doneWhen, expectedBy: isText(expectedBy) ? expectedBy : null };
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
