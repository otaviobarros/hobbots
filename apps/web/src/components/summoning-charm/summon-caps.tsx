import type { Agent } from "@hobbots/domain";
import { Progress } from "@hobbots/ui/components/progress";
import { Skeleton } from "@hobbots/ui/components/skeleton";
import { cn } from "@hobbots/ui/lib/utils";
import { useQuery } from "@tanstack/react-query";
import { useId } from "react";
import { agentsQuery, summonCapsQuery } from "../../api/queries.ts";
import { messages } from "./messages.ts";
import { ReadFailed } from "./read-failed.tsx";
import { SUMMONING_ROW } from "./summoning-row.ts";
import { SummoningSection } from "./summoning-settings.tsx";

/**
 * The hob's live hobs summoned without asking you, against the caps on them (ADR 034): a meter
 * for the hob's own cap, and the cap each Task tree holds. The hub's events keep the hob list
 * current, so a summon or a retirement reads the count again. Until it is read, blocks hold the
 * count's place; when it cannot be read, the section says so with Try again, under the last count
 * it read if it read one before.
 */
export function SummonCapsSection({ hob }: { hob: Agent }) {
  const copy = messages.caps;
  const labelId = useId();
  const hobs = useQuery(agentsQuery);
  const summoned = (hobs.data ?? []).filter((each) => each.summonedBy === hob.id).map((each) => each.id);
  const caps = useQuery(summonCapsQuery(hob.id, summoned));
  const data = caps.data;
  return (
    <SummoningSection label={copy.heading}>
      {!(caps.isError && data === undefined) && (
        <div className={cn(SUMMONING_ROW, "flex-col gap-2.5")}>
          <span className="flex items-baseline gap-2">
            <span id={labelId} className="flex-1 text-text-strong">
              {copy.live({ name: hob.name })}
            </span>
            <span className="font-mono text-detail font-bold text-text-strong">
              {data === undefined ? (
                <Skeleton surface="plain" width="6ch" />
              ) : (
                copy.count({ live: data.live, cap: data.perHob })
              )}
            </span>
          </span>
          <Progress
            aria-labelledby={labelId}
            size="sm"
            value={data?.live ?? 0}
            max={data?.perHob ?? 1}
            tone={data !== undefined && data.live >= data.perHob ? "low" : "default"}
          />
          <span className="text-detail text-text-secondary">
            {data === undefined ? <Skeleton surface="plain" width="40ch" /> : copy.tree({ cap: data.perTree })}
          </span>
          <span className="text-detail text-text-secondary">{copy.note}</span>
        </div>
      )}
      {caps.isError && <ReadFailed text={copy.failed({ name: hob.name })} retry={() => void caps.refetch()} />}
    </SummoningSection>
  );
}
