import type { SkillId } from "@hobbots/domain";
import { Button } from "@hobbots/ui/components/button";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { skillsListQuery } from "../../api/skills.ts";
import { useHobDirectory } from "../../lib/use-hob-directory.ts";
import { skillTitle } from "../skills/skills-model.ts";
import { GiveSkill } from "./give-skill.tsx";
import { everyoneCount, summonOffers } from "./hob-skills-model.ts";
import { messages } from "./messages.ts";

const copy = messages;

/**
 * Summon's Skills row: what a new hob gets without asking, and the same picker as its Skills tab to
 * give it more. Nothing is given until the hob exists; Summon gives the picked skills right after.
 */
export function SummonSkills({
  name,
  picked,
  onPick,
}: {
  name: string;
  picked: ReadonlyArray<SkillId>;
  onPick: (picked: ReadonlyArray<SkillId>) => void;
}) {
  const list = useQuery(skillsListQuery);
  const { hobs } = useHobDirectory();
  const [open, setOpen] = useState(false);
  // A hub without skills, or one that does not answer, summons as before: the row is left out.
  if (list.data === undefined || list.data.skills.length === 0) return null;
  const offers = summonOffers(list.data);
  const names = list.data.skills.filter((skill) => picked.includes(skill.id)).map((skill) => skillTitle(skill.name));
  const toggle = (skillId: SkillId) =>
    onPick(picked.includes(skillId) ? picked.filter((one) => one !== skillId) : [...picked, skillId]);
  return (
    <section aria-label={copy.summon.label} className="flex flex-col gap-2 rounded-card bg-card px-4 py-3">
      <div className="flex items-start gap-4 max-[720px]:flex-wrap">
        <span aria-hidden className="lbl w-[140px] flex-none pt-0.5 text-label">
          {copy.summon.label}
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          <strong>{copy.summon.everyone({ count: everyoneCount(list.data) })}</strong>
          {names.length > 0 && <span className="text-detail text-text-secondary">{copy.summon.picked({ names })}</span>}
        </span>
        {!open && offers.length > 0 && (
          <Button type="button" variant="ghost" size="xs" onClick={() => setOpen(true)}>
            {copy.summon.choose}
          </Button>
        )}
      </div>
      {open && (
        <GiveSkill
          name={name}
          offers={offers}
          hobs={hobs}
          empty={copy.picker.empty({ name })}
          failure={null}
          onClose={() => setOpen(false)}
          action={(offer, titleId) => {
            const on = picked.includes(offer.skill.id);
            return (
              <Button
                type="button"
                variant={on ? "default" : "outline"}
                size="sm"
                aria-pressed={on}
                aria-describedby={titleId}
                onClick={() => toggle(offer.skill.id)}
              >
                {copy.picker.give({ name })}
              </Button>
            );
          }}
        />
      )}
    </section>
  );
}
