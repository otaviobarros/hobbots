import type { TaskTree } from "@hobbots/domain";
import { workCard } from "../quest/work-model.ts";
import { messages } from "./messages.ts";

const copy = messages.sheet;

/**
 * What has to hold for a quest to be done, as its lead wrote it when it started the quest. Its lead
 * decides when each line holds; the sheet only lists them.
 */
export function QuestDoneWhen({ tree }: { tree: TaskTree }) {
  const lines = workCard(tree)?.quest?.acceptance ?? [];
  if (lines.length === 0) return null;
  return (
    <section aria-label={copy.doneWhen} className="flex flex-col gap-2">
      <h3 className="m-0 text-meta font-semibold text-label">{copy.doneWhen}</h3>
      <ul className="m-0 flex list-disc flex-col gap-1 ps-5 text-ui text-text-strong">
        {lines.map((line, index) => (
          // A quest's lines never change once it starts, so their order is their identity.
          // biome-ignore lint/suspicious/noArrayIndexKey: the list is fixed for the quest's life.
          <li key={index} className="wrap-anywhere">
            {line}
          </li>
        ))}
      </ul>
    </section>
  );
}
