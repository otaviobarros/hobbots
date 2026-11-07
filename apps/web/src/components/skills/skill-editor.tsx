import type { SkillDetail } from "@hobbots/api";
import { type SkillId, type SkillRevisionHash, skillRevisionLabel } from "@hobbots/domain";
import { Skeleton } from "@hobbots/ui/components/skeleton";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { skillQuery, skillRevisionQuery, skillsErrorTag } from "../../api/skills.ts";
import { messages } from "./messages.ts";
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
import { useSkillWrites } from "./use-skill-writes.ts";

const copy = messages;

/** Said once the hub answers a save: a new revision, or the same edit sent again, which finishes its rollout. */
const savedLine = (saved: { added: boolean; revision: { number: number }; rolledOut: ReadonlyArray<unknown> }) => {
  const rev = skillRevisionLabel(saved.revision);
  return saved.added || saved.rolledOut.length > 0
    ? copy.rollout.saved({ rev, count: saved.rolledOut.length })
    : copy.editor.same({ rev });
};

/**
 * The edit of `base`, held for as long as the editor is open: the library changing under it, here or
 * elsewhere, never replaces your text or the revision it is made from. A newer revision shows as a
 * conflict, and the hub refuses to save over it.
 */
function EditForm({
  detail,
  base,
  instructions,
  hobs,
  say,
}: {
  detail: SkillDetail;
  base: SkillRevisionHash;
  instructions: string;
  hobs: HobDirectory;
  say: Say;
}) {
  const navigate = useNavigate();
  const writes = useSkillWrites();
  const { skill } = detail;
  const [description, setDescription] = useState(skill.description);
  const [body, setBody] = useState(() => instructionsOf(instructions));
  const [choice, setChoice] = useState<RollOutChoice>(new Map());
  const [failure, setFailure] = useState<string | null>(null);
  const title = skillTitle(skill.name);
  const baseNumber = numberOfPin(detail.revisions, base);
  const now = skillRevisionLabel({ number: baseNumber });
  const next = skillRevisionLabel({ number: baseNumber + 1 });
  const newer = skill.latest === base ? null : skillRevisionLabel({ number: skill.revisions });
  const back = skillView(skill.id);
  const moves = movesWith(choice);
  const moving = detail.assignments.filter(moves).length;
  const valid = descriptionState(description) !== "long" && description.trim() !== "";
  const pending = writes.busy;

  return (
    <form
      noValidate
      className="flex max-w-[760px] flex-col gap-4.5"
      onSubmit={(event) => {
        event.preventDefault();
        if (!valid || pending) return;
        setFailure(null);
        // One request: the hub saves the revision, then the holds, then rolls it out to the rest.
        const keep = detail.assignments.filter((one) => !moves(one)).map((one) => one.id);
        writes.edit
          .mutateAsync({ skillId: skill.id, base, description: description.trim(), instructions: body, keep })
          .then((saved) => {
            say({ tone: "done", message: savedLine(saved) }, back);
            void navigate({ to: "/skills", search: skillsSearchOf(back) });
          })
          .catch((error: unknown) =>
            setFailure(skillsErrorTag(error) === "SkillEditStale" ? copy.editor.stale : copy.editor.failed),
          );
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
          {copy.editor.newer({ rev: newer, base: now })}
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
        saveLabel={pending ? copy.editor.saving : copy.rollout.save({ count: moving, rev: next })}
        disabled={!valid || pending || newer !== null}
        back={back}
      />
    </form>
  );
}

/** Reads the SKILL.md of the revision the editor opened on, and keeps that revision as the edit's base. */
function EditLoader({ detail, hobs, say }: { detail: SkillDetail; hobs: HobDirectory; say: Say }) {
  const [base] = useState(detail.skill.latest);
  const revision = useQuery(skillRevisionQuery(detail.skill.id, base));
  if (revision.isError) return <EditorFailed />;
  if (revision.isPending) return <EditorLoading />;
  return <EditForm detail={detail} base={base} instructions={revision.data.instructions} hobs={hobs} say={say} />;
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
export function SkillEditor({ skillId, hobs, say }: { skillId: SkillId; hobs: HobDirectory; say: Say }) {
  const detail = useQuery(skillQuery(skillId));
  if (detail.data !== undefined) return <EditLoader detail={detail.data} hobs={hobs} say={say} />;
  if (detail.isError) return <EditorFailed />;
  return <EditorLoading />;
}
