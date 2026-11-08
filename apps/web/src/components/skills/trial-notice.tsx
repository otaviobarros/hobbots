import { skillTitle, type Thread } from "@hobbots/domain";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { draftGone, skillTrialDraftQuery } from "../../api/skill-trials.ts";
import { SkillIcon } from "../skill-line/skill-picker.tsx";
import { messages } from "./messages.ts";
import { draftSearch } from "./try-in-chat-model.ts";

const copy = messages.trial;

/**
 * Above the composer of a chat that tries a draft (ADR 029, Try in a chat, #1099): that only the draft
 * is loaded here and nothing reaches the library, with Back to the draft, which opens its editor on
 * the text you tried. Once the hub no longer has the draft, as after a restore, it says so and how to
 * try it again. Nothing in any other chat.
 */
export function TrialNotice({ thread }: { thread: Thread | undefined }) {
  const trial = thread?.skillTrial ?? null;
  const draft = useQuery({ ...skillTrialDraftQuery(thread?.id ?? ("" as Thread["id"])), enabled: trial !== null });
  if (thread === undefined || trial === null) return null;
  const title = skillTitle(trial.name);
  // Only the hub saying so makes the draft gone; a read that failed on the way leaves Back to the draft,
  // whose editor reads it again.
  const gone = draft.isError && draftGone(draft.error);
  return (
    <section
      aria-label={copy.notice({ name: title })}
      className="flex flex-wrap items-center gap-2.5 rounded-card border border-line-2 bg-deep px-3.5 py-2.5 text-ui"
    >
      <span className="flex text-star">
        <SkillIcon />
      </span>
      <span className="min-w-0 flex-1 text-text-secondary">
        <b className="font-semibold text-text-strong">{copy.notice({ name: title })}</b>{" "}
        {gone ? <span role="alert">{copy.draftGone}</span> : copy.noticeHint}
      </span>
      {!gone && (
        <Link to="/skills" search={draftSearch(trial, thread.id)} className="text-ui text-link">
          {copy.backToDraft}
        </Link>
      )}
    </section>
  );
}
