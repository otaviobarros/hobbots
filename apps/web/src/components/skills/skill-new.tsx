import type { Agent } from "@hobbots/domain";
import { Input } from "@hobbots/ui/components/input";
import { useNavigate } from "@tanstack/react-router";
import { useId, useState } from "react";
import { skillsErrorTag } from "../../api/skills.ts";
import { GiveChoice, type GiveTo } from "./give-choice.tsx";
import { messages } from "./messages.ts";
import { DescriptionField, EditorFooter, InstructionsField } from "./skill-fields.tsx";
import type { Say } from "./skills-flash.ts";
import {
  descriptionState,
  nameOf,
  nameValid,
  newSkillFile,
  skillsSearchOf,
  skillTitle,
  skillView,
} from "./skills-model.ts";
import { useSkillWrites } from "./use-skill-writes.ts";

const copy = messages;

/** Write one: a new skill from a blank one, checked as you type, added as r1 and given to whom you pick. */
export function SkillNew({ active, say }: { active: ReadonlyArray<Agent>; say: Say }) {
  const navigate = useNavigate();
  const writes = useSkillWrites();
  const ids = { name: useId(), nameHint: useId() };
  const [typed, setTyped] = useState("");
  const [description, setDescription] = useState("");
  const [body, setBody] = useState("");
  const [give, setGive] = useState<GiveTo>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const name = nameOf(typed);
  const valid = nameValid(name) && description.trim() !== "" && descriptionState(description) !== "long";
  const pending = writes.busy;

  const save = async () => {
    const file = newSkillFile(name, description, body);
    const added = await writes.add.mutateAsync({
      source: { _tag: "Written", files: [{ path: "SKILL.md", text: file }] },
    });
    const [one] = added.imported;
    if (one === undefined) throw new Error("Nothing was added.");
    if (give !== null) await writes.assign.mutateAsync({ skillId: one.skill.id, scope: give });
    return one;
  };

  return (
    <form
      noValidate
      className="flex max-w-[760px] flex-col gap-4.5"
      onSubmit={(event) => {
        event.preventDefault();
        if (!valid || pending) return;
        setFailure(null);
        save()
          .then((one) => {
            const at = skillView(one.skill.id);
            say({ tone: "done", message: copy.editor.added({ name: skillTitle(one.skill.name) }) }, at);
            void navigate({ to: "/skills", search: skillsSearchOf(at) });
          })
          .catch((error: unknown) =>
            setFailure(skillsErrorTag(error) === "SkillNameConflict" ? copy.editor.taken : copy.editor.failed),
          );
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
      <GiveChoice value={give} onChange={setGive} active={active} />
      <EditorFooter
        failure={failure}
        saveLabel={pending ? copy.editor.saving : copy.editor.saveNew}
        disabled={!valid || pending}
        back={{ _tag: "Add", from: "write" }}
      />
    </form>
  );
}
