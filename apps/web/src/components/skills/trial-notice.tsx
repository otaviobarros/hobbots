import { skillTitle, type Thread } from "@hobbots/domain";
import { Link } from "@tanstack/react-router";
import { SkillIcon } from "../skill-line/skill-picker.tsx";
import { messages } from "./messages.ts";
import { skillsSearchOf } from "./skills-model.ts";
import { trialOrigin } from "./try-in-chat-model.ts";

const copy = messages.trial;

/**
 * Above the composer of a chat that tries a draft (ADR 029, Try in a chat, #1099): that only the draft
 * is loaded here and nothing reaches the library, with a way back to where the draft is. Nothing in
 * any other chat.
 */
export function TrialNotice({ thread }: { thread: Thread | undefined }) {
  const trial = thread?.skillTrial ?? null;
  if (trial === null) return null;
  const title = skillTitle(trial.name);
  const origin = trialOrigin(trial);
  return (
    <section
      aria-label={copy.notice({ name: title })}
      className="flex flex-wrap items-center gap-2.5 rounded-card border border-line-2 bg-deep px-3.5 py-2.5 text-ui"
    >
      <span className="flex text-star">
        <SkillIcon />
      </span>
      <span className="min-w-0 flex-1 text-text-secondary">
        <b className="font-semibold text-text-strong">{copy.notice({ name: title })}</b> {copy.noticeHint}
      </span>
      {origin !== null && (
        <Link to="/skills" search={skillsSearchOf(origin)} className="text-ui text-link">
          {origin._tag === "Review" ? copy.backToReview : copy.backToSkill}
        </Link>
      )}
    </section>
  );
}
