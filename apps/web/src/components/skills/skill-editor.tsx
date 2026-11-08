import type { SkillDetail, SkillTrialText } from "@hobbots/api";
import { type SkillId, type SkillRevisionHash, savedSkillInstructions, skillRevisionLabel } from "@hobbots/domain";
import { Skeleton } from "@hobbots/ui/components/skeleton";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { skillQuery, skillRevisionQuery, skillsErrorTag } from "../../api/skills.ts";
import { messages } from "./messages.ts";
import { type EditInput, holdsOf, savedLine, saveLabelOf } from "./skill-editor-model.ts";
import { DescriptionField, EditorFooter, InstructionsField } from "./skill-fields.tsx";
import { movesWith, RollOut, type RollOutChoice } from "./skill-rollout.tsx";
import type { Say } from "./skills-flash.ts";
import {
  descriptionState,
  type HobDirectory,
  instructionsOf,
  numberOfPin,
  skillsSearchOf,
  skillTitle,
  skillView,
} from "./skills-model.ts";
import { TrialDraft } from "./trial-draft.tsx";
import { TryInChat } from "./try-in-chat.tsx";
import { draftFields } from "./try-in-chat-model.ts";
import { useSkillWrites } from "./use-skill-writes.ts";

const copy = messages;

/**
 * The edit of `base`, held for as long as the editor is open: the library changing under it, here or
 * elsewhere, never replaces your text or the revision it is made from. A newer revision shows as a
 * conflict, and the hub refuses to save over it.
 */
function EditForm({
  detail,
  base,
  instructions,
  initial,
  hobs,
  say,
}: {
  detail: SkillDetail;
  base: SkillRevisionHash;
  instructions: string;
  /** The text the editor opens on: the revision's, or the edit you tried in a chat. */
  initial: { readonly description: string; readonly body: string };
  hobs: HobDirectory;
  say: Say;
}) {
  const navigate = useNavigate();
  const writes = useSkillWrites();
  const { skill } = detail;
  const [description, setDescription] = useState(initial.description);
  const [body, setBody] = useState(initial.body);
  // The revision's text, as it saves: the same text makes no revision, so its rollout switches would do nothing.
  const [opened] = useState(() => ({
    description: skill.description.trim(),
    body: savedSkillInstructions(instructionsOf(instructions)),
  }));
  const [choice, setChoice] = useState<RollOutChoice>(new Map());
  const [failure, setFailure] = useState<string | null>(null);
  // A save whose answer never came: it may have reached the hub, so it is sent again as it was.
  const [sent, setSent] = useState<EditInput | null>(null);
  const title = skillTitle(skill.name);
  const baseNumber = numberOfPin(detail.revisions, base);
  const now = skillRevisionLabel({ number: baseNumber });
  const next = skillRevisionLabel({ number: baseNumber + 1 });
  const newer = skill.latest === base ? null : skillRevisionLabel({ number: skill.revisions });
  const finishing = newer !== null && sent !== null;
  const back = skillView(skill.id);
  const moves = movesWith(choice);
  const moving = detail.assignments.filter(moves).length;
  const valid = descriptionState(description) !== "long" && description.trim() !== "";
  const unchanged = description.trim() === opened.description && savedSkillInstructions(body) === opened.body;
  const pending = writes.busy;

  return (
    <form
      noValidate
      className="flex max-w-[760px] flex-col gap-4.5"
      onSubmit={(event) => {
        event.preventDefault();
        if (pending || (!finishing && (!valid || unchanged))) return;
        setFailure(null);
        // One request: the hub saves the revision, and its rollout sets the holds you switched.
        const input = finishing
          ? sent
          : {
              skillId: skill.id,
              base,
              description: description.trim(),
              instructions: body,
              holds: holdsOf(detail, choice),
            };
        writes.edit
          .mutateAsync(input)
          .then((saved) => {
            // Text that saves as this revision or an older one makes nothing and moves no place, so the
            // switches did nothing either: say so, and stay.
            if (saved.revision.number <= baseNumber) {
              setSent(null);
              const rev = skillRevisionLabel(saved.revision);
              setFailure(
                saved.revision.number < baseNumber ? copy.editor.older({ rev }) : copy.editor.sameAsBase({ rev }),
              );
              return;
            }
            say({ tone: "done", message: savedLine(saved) }, back);
            void navigate({ to: "/skills", search: skillsSearchOf(back) });
          })
          .catch((error: unknown) => {
            const tag = skillsErrorTag(error);
            const refused = tag === "SkillEditStale" || tag === "SkillIsReadOnly";
            setSent(refused ? null : input);
            setFailure(
              tag === "SkillEditStale" ? copy.editor.stale : refused ? copy.editor.readOnly : copy.editor.failed,
            );
          });
      }}
    >
      <header className="flex flex-col gap-1">
        <span className="text-detail text-text-secondary">{copy.editor.editing({ name: title, rev: now })}</span>
        <h2 className="m-0 font-heading text-[26px] leading-8 font-bold text-text-strong">
          {copy.editor.editTitle({ name: title })}
        </h2>
        <span className="font-mono text-detail text-label">{copy.editor.typedAsName({ name: skill.name })}</span>
      </header>
      {newer !== null && (
        <p role="status" className="m-0 rounded-card bg-notice px-3.5 py-2.5 text-ui text-text-strong">
          {finishing ? copy.editor.unfinished({ rev: newer }) : copy.editor.newer({ rev: newer, base: now })}
        </p>
      )}
      <DescriptionField value={description} onChange={setDescription} />
      <InstructionsField value={body} onChange={setBody} rows={12} />
      {detail.assignments.length > 0 && (
        <RollOut
          detail={detail}
          hobs={hobs}
          now={now}
          next={next}
          choice={choice}
          onToggle={(id, on) => setChoice((was) => new Map(was).set(id, on))}
        />
      )}
      <EditorFooter
        failure={failure}
        saveLabel={saveLabelOf({ pending, finishing, moving, next })}
        disabled={pending || (finishing ? false : !valid || unchanged || newer !== null)}
        hint={unchanged && !finishing ? copy.editor.unchanged : undefined}
        back={back}
      >
        <TryInChat
          disabled={!valid}
          draft={() => ({ _tag: "Edit", skillId: skill.id, base, description: description.trim(), instructions: body })}
        />
      </EditorFooter>
    </form>
  );
}

/**
 * Reads the SKILL.md of the revision the editor opened on, and keeps that revision as the edit's base:
 * the newest, or, for an edit you tried in a chat, the one that edit was made from.
 */
function EditLoader({
  detail,
  hobs,
  say,
  tried,
}: {
  detail: SkillDetail;
  hobs: HobDirectory;
  say: Say;
  tried: SkillTrialText | null;
}) {
  const [base] = useState(tried?.trial.base ?? detail.skill.latest);
  const revision = useQuery(skillRevisionQuery(detail.skill.id, base));
  if (revision.isError) return <EditorFailed />;
  if (revision.isPending) return <EditorLoading />;
  return (
    <EditForm
      detail={detail}
      base={base}
      instructions={revision.data.instructions}
      initial={
        tried === null
          ? { description: detail.skill.description, body: instructionsOf(revision.data.instructions) }
          : draftFields(tried)
      }
      hobs={hobs}
      say={say}
    />
  );
}

function EditorFailed() {
  return (
    <p role="alert" className="m-0 text-ui text-text-secondary">
      {copy.failed.skill}
    </p>
  );
}

function EditorLoading() {
  return (
    <div aria-busy="true" className="flex max-w-[760px] flex-col gap-3">
      <Skeleton width="40%" />
      <Skeleton width="80%" />
    </div>
  );
}

/**
 * The editor for a skill in the library: it reads the skill and its newest SKILL.md first. Once open,
 * a read of the skill again, after a change or one that fails, keeps the editor and its text.
 */
export function SkillEditor({
  skillId,
  hobs,
  say,
  trial = null,
}: {
  skillId: SkillId;
  hobs: HobDirectory;
  say: Say;
  /** The chat whose tried edit the editor opens on (ADR 029, Try in a chat). */
  trial?: string | null;
}) {
  const detail = useQuery(skillQuery(skillId));
  const found = detail.data;
  if (found !== undefined) {
    return (
      <TrialDraft key={trial ?? "latest"} trial={trial}>
        {(draft) => (
          <EditLoader
            detail={found}
            hobs={hobs}
            say={say}
            tried={draft !== null && draft.trial.skillId === skillId && draft.trial.base !== null ? draft : null}
          />
        )}
      </TrialDraft>
    );
  }
  if (detail.isError) return <EditorFailed />;
  return <EditorLoading />;
}
