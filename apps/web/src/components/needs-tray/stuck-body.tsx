import { BlockerChoices, blockerChoice } from "../blockers/blocker-choices.tsx";
import { blockerWhat, blockerWhy } from "../blockers/blocker-model.ts";
import type { HobLookup } from "../quest/use-work.ts";
import { Details } from "./details.tsx";
import { messages } from "./messages.ts";
import type { TrayEntry } from "./tray-entries.ts";
import { trayTargets } from "./tray-focus.ts";

const copy = messages;

/** Stuck work in the tray: what it was doing, the choices that move it on, and its tries and error. */
export function StuckBody({
  entry,
  asker,
}: {
  entry: Extract<TrayEntry, { kind: "stuck" }>;
  asker: ReturnType<HobLookup>;
}) {
  const choice = blockerChoice(entry.item, asker);
  if (choice === null) return null;
  return (
    <>
      <p className="m-0 text-text">{blockerWhat(entry.item)}</p>
      <BlockerChoices item={entry.item} hob={asker} reassign={false} targets={trayTargets} />
      <Details summary={copy.details.stuck}>
        {blockerWhy(entry.item, choice.blocker, asker.name)}
        {choice.blocker.diagnostic !== null && (
          <span className="mt-1 block font-mono break-words">{choice.blocker.diagnostic}</span>
        )}
      </Details>
    </>
  );
}
