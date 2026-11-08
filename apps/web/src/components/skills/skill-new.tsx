import type { Agent, MemoryProjectIdentity } from "@hobbots/domain";
import { Input } from "@hobbots/ui/components/input";
import { useNavigate } from "@tanstack/react-router";
import { useId, useState } from "react";
import { type importSkills, skillsErrorTag } from "../../api/skills.ts";
import { GiveChoice, type GiveTo } from "./give-choice.tsx";
import { messages } from "./messages.ts";
import { DescriptionField, EditorFooter, InstructionsField } from "./skill-fields.tsx";
import type { Say } from "./skills-flash.ts";
import {
  descriptionState,
  type HobDirectory,
  nameOf,
  nameValid,
  newSkillFile,
  scopeName,
  skillsSearchOf,
  skillTitle,
  skillView,
} from "./skills-model.ts";
import { TrialDraft } from "./trial-draft.tsx";
import { TryInChat } from "./try-in-chat.tsx";
import { draftFields } from "./try-in-chat-model.ts";
import { giveAll, useSkillWrites } from "./use-skill-writes.ts";

const copy = messages;

/** Write one: a new skill from a blank one, checked as you type, added as r1 and given to whom you pick. */
function NewForm({
  active,
  projects,
  hobs,
  say,
  initial,
}: {
  active: ReadonlyArray<Agent>;
  projects: ReadonlyArray<MemoryProjectIdentity>;
  hobs: HobDirectory;
  say: Say;
  initial: { readonly name: string; readonly description: string; readonly body: string } | null;
}) {
  const navigate = useNavigate();
  const writes = useSkillWrites();
  const ids = { name: useId(), nameHint: useId() };
  const [typed, setTyped] = useState(initial?.name ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [body, setBody] = useState(initial?.body ?? "");
  const [give, setGive] = useState<GiveTo>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const name = nameOf(typed);
  const valid = nameValid(name) && description.trim() !== "" && descriptionState(description) !== "long";
  const pending = writes.busy;

  // Two saves, each kept once made: the skill, then giving it out. Adding the same text again is the
  // skill already added, so saving after a failure only gives it out.
  const save = async () => {
    const file = newSkillFile(name, description, body);
    let one: Awaited<ReturnType<typeof importSkills>>["imported"][number] | undefined;
    try {
      const added = await writes.add.mutateAsync({
        source: { _tag: "Written", files: [{ path: "SKILL.md", text: file }] },
      });
      [one] = added.imported;
    } catch (error) {
      return setFailure(skillsErrorTag(error) === "SkillNameConflict" ? copy.editor.taken : copy.editor.failed);
    }
    if (one === undefined) return setFailure(copy.editor.failed);
    const title = skillTitle(one.skill.name);
    if (give !== null && !(await giveAll(writes, [one.skill.id], give))) {
      return setFailure(copy.editor.notGiven({ name: title, who: scopeName(give, hobs) }));
    }
    const at = skillView(one.skill.id);
    const message =
      give === null
        ? copy.editor.added({ name: title })
        : copy.editor.addedGiven({ name: title, who: scopeName(give, hobs) });
    say({ tone: "done", message }, at);
    void navigate({ to: "/skills", search: skillsSearchOf(at) });
  };

  return (
    <form
      noValidate
      className="flex max-w-[760px] flex-col gap-4.5"
      onSubmit={(event) => {
        event.preventDefault();
        if (!valid || pending) return;
        setFailure(null);
        void save();
      }}
    >
      <h2 className="m-0 font-heading text-[26px] leading-8 font-bold text-text-strong">{copy.editor.newTitle}</h2>
      <label htmlFor={ids.name} className="flex flex-col gap-1.5 text-detail text-label">
        {copy.editor.name}
        <Input
          id={ids.name}
          value={typed}
          aria-describedby={ids.nameHint}
          aria-invalid={typed !== "" && !nameValid(name)}
          onChange={(event) => setTyped(event.target.value)}
        />
        <span id={ids.nameHint}>
          {name === ""
            ? copy.editor.nameHint
            : nameValid(name)
              ? copy.editor.typedAsName({ name })
              : copy.editor.typedAsBad({ name })}
        </span>
      </label>
      <DescriptionField value={description} onChange={setDescription} />
      <InstructionsField value={body} onChange={setBody} rows={10} />
      <GiveChoice value={give} onChange={setGive} active={active} projects={projects} />
      <EditorFooter
        failure={failure}
        saveLabel={pending ? copy.editor.saving : copy.editor.saveNew}
        disabled={!valid || pending}
        back={{ _tag: "Add", from: "write" }}
      >
        <TryInChat disabled={!valid} draft={() => ({ _tag: "Written", text: newSkillFile(name, description, body) })} />
      </EditorFooter>
    </form>
  );
}

/**
 * Write one, or, from a chat that tried a new skill, Write one again on the text you tried there
 * (ADR 029, Try in a chat).
 */
export function SkillNew(props: {
  active: ReadonlyArray<Agent>;
  projects: ReadonlyArray<MemoryProjectIdentity>;
  hobs: HobDirectory;
  say: Say;
  trial: string | null;
}) {
  const { trial, ...rest } = props;
  return (
    <TrialDraft key={trial ?? "blank"} trial={trial}>
      {(draft) => (
        <NewForm {...rest} initial={draft !== null && draft.trial.skillId === null ? draftFields(draft) : null} />
      )}
    </TrialDraft>
  );
}
