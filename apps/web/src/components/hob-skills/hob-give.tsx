import type { HobSkills, SkillsList } from "@hobbots/api";
import type { Agent } from "@hobbots/domain";
import { Button } from "@hobbots/ui/components/button";
import { useState } from "react";
import { useHobDirectory } from "../../lib/use-hob-directory.ts";
import { skillTitle } from "../skills/skills-model.ts";
import { GiveSkill } from "./give-skill.tsx";
import { type GiveOffer, giveOffers, ownScope } from "./hob-skills-model.ts";
import { messages } from "./messages.ts";
import { useHobSkillWrites } from "./use-hob-skill-writes.ts";

const copy = messages.picker;

/**
 * Give a hob a skill from the library, or turn a shared one on again for it, behind a Give button.
 * A skill given here is the hob's own, pinned to the newest revision.
 */
export function HobGive({
  hob,
  view,
  list,
  onSaid,
}: {
  hob: Agent;
  view: HobSkills;
  list: SkillsList;
  onSaid: (message: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const writes = useHobSkillWrites();
  const { hobs } = useHobDirectory();
  const offers = giveOffers(view, list);

  const run = (offer: GiveOffer) => {
    setFailure(null);
    const skill = skillTitle(offer.skill.name);
    const done = {
      onSuccess: () => onSaid(copy.given({ name: hob.name, skill })),
      onError: () => setFailure(copy.failed),
    };
    if (offer._tag === "TurnOn")
      writes.optOut.mutate({ agentId: hob.id, skillId: offer.skill.id, optedOut: false }, done);
    else writes.give.mutate({ skillId: offer.skill.id, scope: ownScope(hob.id) }, done);
  };

  if (!open)
    return (
      <Button variant="outline" onClick={() => setOpen(true)}>
        {messages.give({ name: hob.name })}
      </Button>
    );
  return (
    <GiveSkill
      name={hob.name}
      offers={offers}
      hobs={hobs}
      empty={list.skills.length === 0 ? copy.emptyLibrary : copy.empty({ name: hob.name })}
      failure={failure}
      onClose={() => setOpen(false)}
      action={(offer) => (
        <Button
          variant="outline"
          size="sm"
          disabled={writes.busy}
          aria-label={copy.pick({ name: hob.name, skill: skillTitle(offer.skill.name) })}
          onClick={() => run(offer)}
        >
          {offer._tag === "TurnOn" ? copy.turnOn({ name: hob.name }) : copy.give({ name: hob.name })}
        </Button>
      )}
    />
  );
}
