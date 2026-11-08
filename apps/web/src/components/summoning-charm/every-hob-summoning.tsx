import type { SummoningForEveryHob } from "@hobbots/domain";
import { Skeleton } from "@hobbots/ui/components/skeleton";
import { Switch } from "@hobbots/ui/components/switch";
import { useQuery } from "@tanstack/react-query";
import { useId } from "react";
import { useUpdateSetup, watchedSetupQuery } from "../../api/setup.ts";
import { CharmMark } from "../hob-profile/github-charm.tsx";
import { messages } from "./messages.ts";
import { EVERY_HOB_ON, everyHobEditPayload, everyHobSummoning } from "./summoning-model.ts";
import { SummoningSettings } from "./summoning-settings.tsx";

/**
 * "Summoning for every hob" in Settings › Connections › Charms (ADR 034): off by default, one scope
 * and one set of field answers for every hob you made, and never for a hob that a hob summoned. A
 * hob's own Charms tab can take it away from that hob, or give it its own scope and answers.
 */
export function EveryHobSummoning() {
  const copy = messages.everyHob;
  const setup = useQuery(watchedSetupQuery);
  const update = useUpdateSetup();
  const switchId = useId();
  const sending = update.isPending ? update.variables?.summoningForEveryHob : undefined;
  const everyHob: SummoningForEveryHob | null | undefined =
    sending === undefined ? setup.data?.summoningForEveryHob : sending;
  const view = everyHobSummoning(everyHob ?? null);
  const on = view.held !== "off";
  const pending = update.isPending || setup.data === undefined;
  const save = (summoningForEveryHob: SummoningForEveryHob | null) => update.mutate({ summoningForEveryHob });

  return (
    <section aria-label={copy.name} className="flex flex-col gap-3.5 rounded-card bg-card p-4">
      <div className="flex items-center gap-3">
        <CharmMark off={!on} mark="✦" />
        <span className="flex min-w-0 flex-1 flex-col">
          <label htmlFor={switchId} className="font-bold text-text-strong">
            {copy.name}
          </label>
          <span className="text-detail text-text-secondary">{on ? copy.on : copy.off}</span>
        </span>
        {setup.data === undefined ? (
          <Skeleton shape="dot" surface="card" className="h-6 w-[46px]" />
        ) : (
          <Switch
            id={switchId}
            checked={on}
            disabled={pending}
            onCheckedChange={(next) => save(next ? EVERY_HOB_ON : null)}
          />
        )}
      </div>
      {on && (
        <div className="flex animate-hb-in flex-col gap-4.5">
          <SummoningSettings
            name={messages.scope.theHob}
            self={null}
            view={view}
            pending={pending}
            labels={{ who: copy.who, mayDo: copy.mayDo, note: copy.note }}
            onEdit={(edit) => save(everyHobEditPayload(view, edit))}
          />
        </div>
      )}
      {update.isError && (
        <span role="alert" className="text-detail text-rose">
          {copy.saveFailed}
        </span>
      )}
    </section>
  );
}
