import type { Agent } from "@hobbots/domain";
import { Button } from "@hobbots/ui/components/button";
import { Link } from "@tanstack/react-router";
import { messages } from "../messages.ts";
import { HobSummoning } from "../summoning-charm/hob-summoning.tsx";
import { GitHubCharm } from "./github-charm.tsx";
import { LoadFailed, useHobPermissions } from "./hob-permissions.tsx";

/**
 * The hob's Charms (ADR 014): one card for each app connected in Settings, each with who the hob
 * acts as there and what it may do, then the Summoning Charm (ADR 034).
 */
export function CharmsTab({ hob }: { hob: Agent }) {
  const copy = messages.charms;
  const permissions = useHobPermissions(hob);
  if (permissions.isError) {
    return <LoadFailed name={hob.name} retry={() => void permissions.refetch()} />;
  }
  return (
    <div className="flex max-w-form-max flex-col gap-4">
      <span className="text-text-secondary">{copy.intro({ name: hob.name })}</span>
      <GitHubCharm
        hob={hob}
        permissions={permissions.data}
        outdated={permissions.outdated}
        retry={() => void permissions.refetch()}
      />
      <HobSummoning hob={hob} permissions={permissions.data} outdated={permissions.outdated} />
      <div className="flex items-center gap-3 rounded-card border-(length:--edge) border-dashed border-line-2 px-4 py-3.5">
        <span className="flex-1 text-ui text-text-secondary">{copy.more}</span>
        <Button asChild variant="outline">
          <Link to="/settings/$section" params={{ section: "connections" }} search={{ tab: "charms" }}>
            {copy.moreLink}
          </Link>
        </Button>
      </div>
    </div>
  );
}
