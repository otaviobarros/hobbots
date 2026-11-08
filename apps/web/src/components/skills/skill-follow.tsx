import type { SkillsList } from "@hobbots/api";
import { type SkillId, skillRevisionLabel } from "@hobbots/domain";
import { Button } from "@hobbots/ui/components/button";
import { Switch } from "@hobbots/ui/components/switch";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  acceptSkillUpdate,
  checkSkillUpdates,
  dismissSkillUpdate,
  setSkillAutoUpdate,
  skillUpdatesQuery,
} from "../../api/skill-updates.ts";
import { refreshSkills } from "../../api/skills.ts";
import { MemoryCard } from "../memory/memory-parts.tsx";
import { messages } from "./messages.ts";
import { fromGit, gitSkillCount, updateOf, updatesFrom } from "./skill-updates-model.ts";
import type { Say } from "./skills-flash.ts";
import { skillsSearchOf } from "./skills-model.ts";

const copy = messages.updates;

/**
 * Your decisions on updates from a source (ADR 029, Updates from a source): Check now, accept, Not
 * now and Update automatically. Each reads the library again, Updates with it (STD-REACT-012).
 */
export const useSkillUpdateWrites = () => {
  const queryClient = useQueryClient();
  const onSuccess = () => refreshSkills(queryClient);
  const check = useMutation({ mutationFn: checkSkillUpdates, onSuccess });
  const accept = useMutation({ mutationFn: acceptSkillUpdate, onSuccess });
  const dismiss = useMutation({ mutationFn: dismissSkillUpdate, onSuccess });
  const automatic = useMutation({ mutationFn: setSkillAutoUpdate, onSuccess });
  const busy = [check, accept, dismiss, automatic].some((one) => one.isPending);
  return { check, accept, dismiss, automatic, busy };
};

/** Check for updates, in the page's header: reads every Git source now and says what it found. */
export function CheckForUpdates({ list, say }: { list: SkillsList | undefined; say: Say }) {
  const writes = useSkillUpdateWrites();
  if (list === undefined || gitSkillCount(list) === 0) return null;
  return (
    <Button
      variant="outline"
      disabled={writes.check.isPending}
      onClick={() =>
        writes.check.mutate(undefined, {
          onSuccess: (done) =>
            say({
              tone: "done",
              message: copy.checked({
                count: gitSkillCount(list),
                waiting: done.updates.length,
                updated: done.updated.length,
              }),
            }),
          onError: () => say({ tone: "failed", message: copy.checkFailed }),
        })
      }
    >
      {writes.check.isPending ? copy.checking : copy.check}
    </Button>
  );
}

/** The Update automatically switch of one skill, with what it does. */
export function AutoUpdateSwitch({ skillId, on, say }: { skillId: SkillId; on: boolean; say: Say }) {
  const writes = useSkillUpdateWrites();
  return (
    <div className="flex flex-col gap-1.5">
      <span className="flex items-center gap-2.5">
        <span className="flex-1 text-ui font-semibold text-text-strong">{copy.auto}</span>
        <Switch
          checked={on}
          disabled={writes.automatic.isPending}
          aria-label={copy.auto}
          onCheckedChange={(checked) =>
            writes.automatic.mutate(
              { skillId, on: checked },
              { onError: () => say({ tone: "failed", message: copy.autoFailed }) },
            )
          }
        />
      </span>
      <span className="text-detail text-text-secondary">{on ? copy.autoOn : copy.autoOff}</span>
    </div>
  );
}

/**
 * Beside a skill from Git: an update that waits for it, where it updates from when it does so by
 * itself, and the switch. Any other skill has none.
 */
export function SkillFollow({ skill, list, say }: { skill: SkillsList["skills"][number]; list: SkillsList; say: Say }) {
  const updates = useQuery(skillUpdatesQuery);
  if (!fromGit(skill, list) || skill.sourceId === null) return null;
  const update = updateOf(updates.data?.updates, skill.id);
  const on = updates.data?.automatic.includes(skill.id) ?? false;
  return (
    <MemoryCard label={copy.title}>
      <h3 className="lbl m-0 text-label">{copy.title}</h3>
      {update !== null && (
        <Button asChild variant="outline">
          <Link to="/skills" search={skillsSearchOf({ _tag: "Updates", item: skill.id })}>
            {copy.available({ to: skillRevisionLabel({ number: update.baseNumber + 1 }) })}
          </Link>
        </Button>
      )}
      {on && (
        <span className="text-detail text-text-strong">
          {copy.autoFrom({ where: updatesFrom(skill.sourceId, list) })}
        </span>
      )}
      <AutoUpdateSwitch skillId={skill.id} on={on} say={say} />
    </MemoryCard>
  );
}
