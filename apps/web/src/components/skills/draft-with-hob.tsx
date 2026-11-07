import type { Agent } from "@hobbots/domain";
import { cn } from "@hobbots/ui/lib/utils";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useId, useState } from "react";
import { appendDraft, readDraft } from "../../api/drafts.ts";
import { watchedSetupQuery } from "../../api/setup.ts";
import { HobSprite } from "../hob-sprite/hob-sprite.tsx";
import { messages } from "./messages.ts";
import { draftingHobs, skillsSearchOf } from "./skills-model.ts";

const copy = messages.import;

const CARD =
  "flex flex-col items-start gap-1 rounded-card border-(length:--edge) border-solid border-line-2 bg-card p-3.5 text-start text-text-strong no-underline hover:border-control";

/**
 * Starts a hob's new chat from the drafting message. Text already waiting there stays, with the
 * message after it, and choosing the same hob again does not add the message twice.
 */
const startDraft = (hob: Agent) => {
  const place = `new-${hob.id}` as const;
  if (!readDraft(place).includes(copy.draftMessage)) appendDraft(place, copy.draftMessage);
};

/** The hobs that may draft a skill, each opening a new chat with it. */
function DraftPicker({ active, labelId }: { active: ReadonlyArray<Agent>; labelId: string }) {
  const setup = useQuery(watchedSetupQuery);
  const preset = setup.data?.safetyPreset;
  if (preset === undefined) {
    return setup.isError ? (
      <p role="alert" className="m-0 text-ui text-text-secondary">
        {copy.draftLookFailed}
      </p>
    ) : (
      <p role="status" className="m-0 text-ui text-text-secondary">
        {copy.draftLooking}
      </p>
    );
  }
  const hobs = draftingHobs(active, preset);
  if (hobs.length === 0) return <p className="m-0 text-ui text-text-secondary">{copy.draftNone}</p>;
  return (
    <ul aria-labelledby={labelId} className="m-0 grid list-none grid-cols-3 gap-2 p-0 max-[900px]:grid-cols-1">
      {hobs.map((hob) => (
        <li key={hob.id} className="flex">
          <Link
            to="/hobs/$hobId/new"
            params={{ hobId: hob.id }}
            onClick={() => startDraft(hob)}
            className="flex w-full items-center gap-2.5 rounded-card bg-card px-3 py-2.5 text-text-strong no-underline hover:bg-hover"
          >
            <span aria-hidden className="flex size-8 flex-none items-center justify-center rounded-tile bg-deep">
              <HobSprite hob={hob} size={24} />
            </span>
            <span className="flex min-w-0 flex-col">
              <span className="truncate text-ui font-semibold">{hob.name}</span>
              <span className="truncate text-meta text-label">{hob.roleTitle}</span>
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

/**
 * Write one: a blank skill in the editor, or a chat where a hob drafts it. A hob's draft is a
 * proposal like any other, so it waits in To review, attributed to that chat.
 */
export function WriteOne({ active }: { active: ReadonlyArray<Agent> }) {
  const [picking, setPicking] = useState(false);
  const pickerId = useId();
  const labelId = useId();
  return (
    <div className="flex flex-col gap-3.5">
      <div className="grid grid-cols-2 gap-3 max-[900px]:grid-cols-1">
        <Link to="/skills" search={skillsSearchOf({ _tag: "New" })} className={CARD}>
          <span className="text-body font-semibold">{copy.blank}</span>
          <span className="text-detail text-text-secondary">{copy.blankHint}</span>
        </Link>
        <button
          type="button"
          aria-expanded={picking}
          aria-controls={pickerId}
          onClick={() => setPicking((was) => !was)}
          className={cn(
            CARD,
            "cursor-pointer",
            picking && "border-focus-ring shadow-[0_0_0_1px_var(--color-focus-ring)]",
          )}
        >
          <span className="text-body font-semibold">{copy.draft}</span>
          <span className="text-detail text-text-secondary">{copy.draftHint}</span>
        </button>
      </div>
      {picking && (
        <section id={pickerId} aria-labelledby={labelId} className="flex flex-col gap-2">
          <h3 id={labelId} className="lbl m-0 text-meta leading-4 text-label">
            {copy.draftWho}
          </h3>
          <p className="m-0 text-detail text-text-secondary">{copy.draftWhoHint}</p>
          <DraftPicker active={active} labelId={labelId} />
        </section>
      )}
    </div>
  );
}
