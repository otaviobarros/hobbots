import type { SkillDetail, SkillsList } from "@hobbots/api";
import { type Agent, SkillName, type SkillScope, type SkillSetSkill } from "@hobbots/domain";
import { Button } from "@hobbots/ui/components/button";
import { useNavigate } from "@tanstack/react-router";
import { Schema } from "effect";
import { useId, useState } from "react";
import { skillsErrorTag } from "../../api/skills.ts";
import { messages } from "./messages.ts";
import type { Say } from "./skills-flash.ts";
import { projectName, skillsSearchOf, skillTitle, skillView } from "./skills-model.ts";
import { useSkillWrites } from "./use-skill-writes.ts";

const copy = messages;

const isSkillName = Schema.is(SkillName);

/** Who a copy can go to: nobody yet, Everyone, each project hobs work in, and each hob. */
const choicesFor = (list: SkillsList, active: ReadonlyArray<Agent>, inSet: boolean) => [
  {
    key: "none",
    scope: null,
    label: copy.copySkill.nobody,
    note: inSet ? copy.copySkill.nobodyNoteSet : copy.copySkill.nobodyNote,
  },
  {
    key: "everyone",
    scope: { _tag: "Everyone" } as SkillScope,
    label: copy.give.everyone,
    note: copy.copySkill.everyoneNote,
  },
  ...list.projects.map((identity) => ({
    key: `project:${identity}`,
    scope: { _tag: "Project", identity } as SkillScope,
    label: copy.give.project({ name: projectName(identity) }),
    note: copy.copySkill.projectNote,
  })),
  ...active.map((hob) => ({
    key: `hob:${hob.id}`,
    scope: { _tag: "Hob", agentId: hob.id } as SkillScope,
    label: hob.name,
    note: copy.copySkill.hobNote({ name: hob.name }),
  })),
];

/**
 * Make a copy (ADR 029): a skill written in Hobbots with the same files at r1, under a new name, that
 * you can edit. It goes to nobody until you pick who gets it; the original stays as it is. For a
 * skill of a set, `member` is the one copied, as a skill of its own (ADR 029, Skill sets).
 */
export function SkillCopy({
  detail,
  list,
  active,
  say,
  member,
}: {
  detail: SkillDetail;
  list: SkillsList;
  active: ReadonlyArray<Agent>;
  say: Say;
  member?: SkillSetSkill;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(`${member?.name ?? detail.skill.name}-copy`);
  const [who, setWho] = useState("none");
  const [failure, setFailure] = useState<string | null>(null);
  const writes = useSkillWrites();
  const navigate = useNavigate();
  const nameHint = useId();
  const title = skillTitle(member?.name ?? detail.skill.name);
  const choices = choicesFor(list, active, member !== undefined);
  const picked = choices.find((choice) => choice.key === who) ?? choices[0];
  const valid = isSkillName(name);
  const files = member === undefined ? (detail.revisions[0]?.files.length ?? 0) : null;

  const submit = () => {
    if (!isSkillName(name)) return setFailure(copy.copySkill.invalid);
    setFailure(null);
    writes.copy.mutate(
      {
        skillId: detail.skill.id,
        name,
        ...(picked?.scope == null ? {} : { scope: picked.scope }),
        ...(member === undefined ? {} : { member: member.name }),
      },
      {
        onSuccess: (copied) => {
          // The line is said on the copy's page, where it opens.
          const at = skillView(copied.skill.id);
          const named = skillTitle(copied.skill.name);
          const message =
            member === undefined
              ? copy.copySkill.done({ name: named })
              : copy.copySkill.doneSet({ name: named, set: detail.skill.name });
          say({ tone: "done", message }, at);
          void navigate({ to: "/skills", search: skillsSearchOf(at) });
        },
        onError: (error) =>
          setFailure(skillsErrorTag(error) === "SkillNameConflict" ? copy.copySkill.taken : copy.copySkill.failed),
      },
    );
  };

  return (
    <>
      <Button variant="outline" aria-expanded={open} onClick={() => setOpen(!open)}>
        {copy.copySkill.open}
      </Button>
      {open && (
        <form
          aria-label={copy.copySkill.label({ name: title })}
          className="flex flex-col gap-2.5 rounded-card bg-panel p-3"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <label className="flex flex-col gap-1 text-detail text-text-secondary">
            {copy.copySkill.name}
            <input
              type="text"
              value={name}
              spellCheck={false}
              aria-describedby={nameHint}
              aria-invalid={!valid}
              onChange={(event) => setName(event.target.value)}
              className="focus-ring rounded-control border border-line-2 bg-card px-2.5 py-1.5 font-mono text-ui text-text-strong"
            />
            <span id={nameHint} className="text-meta text-label">
              {copy.copySkill.nameHint}
            </span>
          </label>
          <fieldset className="m-0 flex flex-col gap-0.5 border-0 p-0">
            <legend className="mb-1 p-0 text-detail text-text-secondary">{copy.copySkill.who}</legend>
            {choices.map((choice) => (
              <label
                key={choice.key}
                className="flex cursor-pointer items-center gap-2 rounded-control px-2 py-1.5 text-ui text-text-strong hover:bg-hover"
              >
                <input
                  type="radio"
                  name={`copy-${detail.skill.id}`}
                  value={choice.key}
                  checked={who === choice.key}
                  onChange={() => setWho(choice.key)}
                  className="size-3.5 accent-(--color-mint-deep)"
                />
                {choice.label}
              </label>
            ))}
          </fieldset>
          <span className="text-detail text-text-secondary">
            {`${files === null ? copy.copySkill.startsSet : copy.copySkill.starts({ count: files })} ${picked?.note ?? ""}`}
          </span>
          {failure !== null && (
            <p role="alert" className="m-0 text-detail text-rose">
              {failure}
            </p>
          )}
          <div className="flex flex-wrap gap-1.5">
            <Button type="submit" size="sm" disabled={writes.busy || !valid}>
              {writes.copy.isPending ? copy.copySkill.copying : copy.copySkill.confirm}
            </Button>
            <Button type="button" variant="quiet" size="sm" onClick={() => setOpen(false)}>
              {copy.copySkill.cancel}
            </Button>
          </div>
        </form>
      )}
    </>
  );
}
