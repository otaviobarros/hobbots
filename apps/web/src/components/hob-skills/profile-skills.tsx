import type { Agent } from "@hobbots/domain";
import { Button } from "@hobbots/ui/components/button";
import { Skeleton } from "@hobbots/ui/components/skeleton";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useHobSkills } from "../../api/hob-skills.ts";
import { skillsListQuery } from "../../api/skills.ts";
import { useHobDirectory } from "../../lib/use-hob-directory.ts";
import { HobCarries } from "./hob-carries.tsx";
import { HobGive } from "./hob-give.tsx";
import { messages } from "./messages.ts";

const copy = messages;

/**
 * What a hob carries and the picker to give it more, wherever its skills are managed: its profile's
 * Skills tab, beside its Charms, and its scope on the Skills page.
 */
export function HobSkillsManage({ hob }: { hob: Agent }) {
  const view = useHobSkills(hob.id, hob.configVersion);
  const list = useQuery(skillsListQuery);
  const { hobs } = useHobDirectory();
  const [said, setSaid] = useState<{ message: string; failed: boolean } | null>(null);
  const failed = view.error ?? list.error;

  if (view.data === undefined || list.data === undefined)
    return failed === null ? (
      <div aria-busy="true" className="flex flex-col gap-3">
        <Skeleton width="50ch" />
        <Skeleton width="70%" />
      </div>
    ) : (
      <p role="alert" className="m-0 flex items-center gap-3 rounded-card bg-notice px-4 py-3 text-ui text-text">
        <span className="flex-1">{copy.failed}</span>
        <Button
          variant="outline"
          size="xs"
          onClick={() => {
            void view.refetch();
            void list.refetch();
          }}
        >
          {copy.retry}
        </Button>
      </p>
    );

  return (
    <div className="flex flex-col gap-4">
      <p className="m-0 text-ui text-text-secondary">
        {copy.carries.line({ name: hob.name, count: view.data.skills.length })}
      </p>
      {said !== null && (
        <p
          role={said.failed ? "alert" : "status"}
          className="m-0 rounded-card bg-notice px-3.5 py-2.5 text-ui text-text-strong"
        >
          {said.message}
        </p>
      )}
      <HobCarries
        hob={hob}
        view={view.data}
        list={list.data}
        hobs={hobs}
        onSaid={(message, failed = false) => setSaid({ message, failed })}
      />
      <HobGive hob={hob} view={view.data} list={list.data} onSaid={(message) => setSaid({ message, failed: false })} />
    </div>
  );
}
