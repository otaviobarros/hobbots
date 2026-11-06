import type { SkillDetail } from "@hobbots/api";
import { type SkillAssignmentId, type SkillId, skillRevisionLabel } from "@hobbots/domain";
import { Skeleton } from "@hobbots/ui/components/skeleton";
import { Switch } from "@hobbots/ui/components/switch";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { skillQuery, skillRevisionQuery } from "../../api/skills.ts";
import { messages } from "./messages.ts";
import { DescriptionField, EditorFooter, InstructionsField } from "./skill-fields.tsx";
import type { Say } from "./skills-flash.ts";
import {
  descriptionState,
  type HobDirectory,
  instructionsOf,
  scopeName,
  skillsSearchOf,
  skillTitle,
  skillView,
} from "./skills-model.ts";
import { ScopeMark } from "./skills-parts.tsx";
import { type SkillWrites, useSkillWrites } from "./use-skill-writes.ts";

const copy = messages;

/** The places an edit rolls out to, each switched on unless it is kept on its revision. */
function RollOut({
  detail,
  hobs,
  moving,
  onToggle,
}: {
  detail: SkillDetail;
  hobs: HobDirectory;
  moving: ReadonlySet<SkillAssignmentId>;
  onToggle: (id: SkillAssignmentId, on: boolean) => void;
}) {
  const now = skillRevisionLabel({ number: detail.skill.revisions });
  const next = skillRevisionLabel({ number: detail.skill.revisions + 1 });
  return (
    <section
      aria-label={copy.rollout.title({ count: moving.size })}
      className="flex flex-col gap-2.5 rounded-card bg-card p-4"
    >
      <h3 className="m-0 font-heading text-[16px] leading-[22px] font-bold text-text-strong">
        {copy.rollout.title({ count: moving.size })}
      </h3>
      <p className="m-0 text-detail text-text-secondary">{copy.rollout.body({ next, now })}</p>
      <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
        {detail.assignments.map((assignment) => {
          const who = scopeName(assignment.scope, hobs);
          const on = moving.has(assignment.id);
          const hob = assignment.scope._tag === "Hob" ? hobs.get(assignment.scope.agentId) : undefined;
          return (
            <li key={assignment.id} className="flex items-center gap-2.5 px-1 py-1.5">
              <ScopeMark scope={assignment.scope} hob={hob} />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="text-ui text-text-strong">{who}</span>
                <span className="text-meta text-label">
                  {on ? copy.rollout.follows : copy.rollout.held({ rev: now })}
                </span>
              </span>
              <Switch
                checked={on}
                aria-label={copy.rollout.moves({ who, rev: next })}
                onCheckedChange={(checked) => onToggle(assignment.id, checked)}
              />
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** Holds what you switched off and lets go of what you switched on, then saves the edit, which rolls out to the rest. */
const saveEdit = async (
  writes: SkillWrites,
  detail: SkillDetail,
  moving: ReadonlySet<SkillAssignmentId>,
  edit: { description: string; instructions: string },
) => {
  for (const assignment of detail.assignments) {
    const held = !moving.has(assignment.id);
    if (held !== assignment.held) await writes.hold.mutateAsync({ assignmentId: assignment.id, held });
  }
  return writes.edit.mutateAsync({ skillId: detail.skill.id, base: detail.skill.latest, ...edit });
};

function EditForm({
  detail,
  instructions,
  hobs,
  say,
}: {
  detail: SkillDetail;
  instructions: string;
  hobs: HobDirectory;
  say: Say;
}) {
  const navigate = useNavigate();
  const writes = useSkillWrites();
  const { skill } = detail;
  const [description, setDescription] = useState(skill.description);
  const [body, setBody] = useState(() => instructionsOf(instructions));
  const [moving, setMoving] = useState<ReadonlySet<SkillAssignmentId>>(
    () => new Set(detail.assignments.filter((one) => !one.held).map((one) => one.id)),
  );
  const [failed, setFailed] = useState(false);
  const title = skillTitle(skill.name);
  const next = skillRevisionLabel({ number: skill.revisions + 1 });
  const back = skillView(skill.id);
  const valid = descriptionState(description) !== "long" && description.trim() !== "";
  const pending = writes.busy;

  return (
    <form
      noValidate
      className="flex max-w-[760px] flex-col gap-4.5"
      onSubmit={(event) => {
        event.preventDefault();
        if (!valid || pending) return;
        setFailed(false);
        saveEdit(writes, detail, moving, { description: description.trim(), instructions: body })
          .then((saved) => {
            const rev = skillRevisionLabel(saved.revision);
            const message = saved.added
              ? copy.rollout.saved({ rev, count: saved.rolledOut.length })
              : copy.editor.same({ rev });
            say({ tone: "done", message }, back);
            void navigate({ to: "/skills", search: skillsSearchOf(back) });
          })
          .catch(() => setFailed(true));
      }}
    >
      <header className="flex flex-col gap-1">
        <span className="text-detail text-text-secondary">
          {copy.editor.editing({ name: title, rev: skillRevisionLabel({ number: skill.revisions }) })}
        </span>
        <h2 className="m-0 font-heading text-[26px] leading-8 font-bold text-text-strong">
          {copy.editor.editTitle({ name: title })}
        </h2>
        <span className="font-mono text-detail text-label">{copy.editor.typedAsName({ name: skill.name })}</span>
      </header>
      <DescriptionField value={description} onChange={setDescription} />
      <InstructionsField value={body} onChange={setBody} rows={12} />
      {detail.assignments.length > 0 && (
        <RollOut
          detail={detail}
          hobs={hobs}
          moving={moving}
          onToggle={(id, on) =>
            setMoving((was) => {
              const now = new Set(was);
              if (on) now.add(id);
              else now.delete(id);
              return now;
            })
          }
        />
      )}
      <EditorFooter
        failure={failed ? copy.editor.failed : null}
        saveLabel={pending ? copy.editor.saving : copy.rollout.save({ count: moving.size, rev: next })}
        disabled={!valid || pending}
        back={back}
      />
    </form>
  );
}

/** Reads the newest SKILL.md of a skill before its editor opens. */
function EditLoader({ detail, hobs, say }: { detail: SkillDetail; hobs: HobDirectory; say: Say }) {
  const revision = useQuery(skillRevisionQuery(detail.skill.id, detail.skill.latest));
  if (revision.isError) return <EditorFailed />;
  if (revision.isPending) return <EditorLoading />;
  return <EditForm detail={detail} instructions={revision.data.instructions} hobs={hobs} say={say} />;
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

/** The editor for a skill in the library: it reads the skill and its newest SKILL.md first. */
export function SkillEditor({ skillId, hobs, say }: { skillId: SkillId; hobs: HobDirectory; say: Say }) {
  const detail = useQuery(skillQuery(skillId));
  if (detail.isError) return <EditorFailed />;
  if (detail.isPending) return <EditorLoading />;
  return <EditLoader detail={detail.data} hobs={hobs} say={say} />;
}
