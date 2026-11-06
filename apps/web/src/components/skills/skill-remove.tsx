import type { SkillDetail } from "@hobbots/api";
import { Button } from "@hobbots/ui/components/button";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { formatList } from "../../lib/format.ts";
import { messages } from "./messages.ts";
import type { Say } from "./skills-flash.ts";
import { type HobDirectory, scopeName, skillTitle } from "./skills-model.ts";
import { useSkillWrites } from "./use-skill-writes.ts";

const copy = messages;

/**
 * Remove from the library: asks first. A skill something still gives cannot go, so the question says
 * who has it instead, and the hub refuses it the same way if that changed meanwhile.
 */
export function SkillRemove({ detail, hobs, say }: { detail: SkillDetail; hobs: HobDirectory; say: Say }) {
  const [open, setOpen] = useState(false);
  const writes = useSkillWrites();
  const navigate = useNavigate();
  const title = skillTitle(detail.skill.name);
  const users = detail.assignments.map((assignment) => scopeName(assignment.scope, hobs));
  return (
    <>
      <Button variant="quiet" className="justify-start" aria-expanded={open} onClick={() => setOpen(!open)}>
        {copy.remove.open}
      </Button>
      {open && (
        <div
          role="alertdialog"
          aria-label={copy.remove.label({ name: title })}
          className="flex flex-col gap-2 rounded-card bg-[color-mix(in_srgb,var(--color-rose)_10%,var(--color-card))] p-3"
        >
          <b className="text-ui font-semibold text-text-strong">
            {users.length === 0 ? copy.remove.title : copy.remove.inUse({ count: users.length })}
          </b>
          <span className="text-detail text-text-secondary">
            {users.length === 0 ? copy.remove.body : copy.remove.inUseBody({ who: formatList(users) })}
          </span>
          <div className="flex flex-wrap gap-1.5">
            {users.length === 0 && (
              <Button
                variant="deny"
                size="xs"
                disabled={writes.busy}
                onClick={() =>
                  writes.remove.mutate(detail.skill.id, {
                    onSuccess: () => {
                      say({ tone: "done", message: copy.remove.done({ name: title }) }, { _tag: "Overview" });
                      void navigate({ to: "/skills", search: {} });
                    },
                    onError: () => say({ tone: "failed", message: copy.remove.failed }),
                  })
                }
              >
                {writes.remove.isPending ? copy.remove.removing : copy.remove.confirm}
              </Button>
            )}
            <Button variant="quiet" size="xs" onClick={() => setOpen(false)}>
              {copy.remove.cancel}
            </Button>
          </div>
        </div>
      )}
    </>
  );
}
