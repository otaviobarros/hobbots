import type { HobPermissions, UpdateHobPermissionsPayload } from "@hobbots/api";
import type { Agent, HobPolicy } from "@hobbots/domain";
import { Badge } from "@hobbots/ui/components/badge";
import { Skeleton } from "@hobbots/ui/components/skeleton";
import { Switch } from "@hobbots/ui/components/switch";
import { cn } from "@hobbots/ui/lib/utils";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useId } from "react";
import { useUpdatePermissions } from "../../api/queries.ts";
import { watchedSetupQuery } from "../../api/setup.ts";
import { CharmMark } from "../hob-profile/github-charm.tsx";
import { CardSaveOutcome } from "../hob-profile/saved-bar.tsx";
import { messages } from "./messages.ts";
import { SummonCapsSection } from "./summon-caps.tsx";
import { hobEditPayload, hobSummoning, hobSwitchPayload, type SummoningHeld } from "./summoning-model.ts";
import { SummoningSettings } from "./summoning-settings.tsx";

const STATE_BADGE = { off: "resting", own: "working", "every-hob": "working" } as const satisfies Record<
  SummoningHeld,
  string
>;

/** The policy as it stands once a change on its way to the hub lands, so the card shows it at once. */
const sentPolicy = (policy: HobPolicy, sending: UpdateHobPermissionsPayload | undefined): HobPolicy =>
  sending?.charms === undefined ? policy : { ...policy, charms: { ...policy.charms, ...sending.charms } };

/**
 * The Summoning Charm on a hob's Charms tab (ADR 034): its switch, who the hob may manage and Allow,
 * Ask or Never per field. It shows "Summoning for every hob" when that reaches the hob, and a change
 * here gives the hob its own grant. Every change is saved at once as the hob's next configuration
 * version, so the hob's next call runs under it, and one that narrows revokes the grants that relied
 * on it (ADR 015).
 */
export function HobSummoning({
  hob,
  permissions,
  outdated,
}: {
  hob: Agent;
  /** The hob's permissions, or undefined while the hub reads them. */
  permissions: HobPermissions | undefined;
  outdated: boolean;
}) {
  const copy = messages.hob;
  const setup = useQuery(watchedSetupQuery);
  const update = useUpdatePermissions(hob.id);
  const everyHob = setup.data?.summoningForEveryHob ?? null;
  const ready = permissions !== undefined && setup.data !== undefined;
  const sending = update.isPending ? update.variables : undefined;
  const stored = { policy: permissions?.policy ?? hob.policy, summonedBy: hob.summonedBy };
  const view = hobSummoning({ ...stored, policy: sentPolicy(stored.policy, sending) }, everyHob);
  const current = hobSummoning(stored, everyHob);
  const on = view.held !== "off";
  const pending = update.isPending || outdated || !ready;

  return (
    <section
      aria-label={copy.card}
      aria-busy={!ready}
      className={cn(
        "flex flex-col rounded-card bg-card",
        on && ready
          ? "shadow-[inset_0_0_0_1px_var(--color-line),inset_0_3px_0_var(--color-mint-deep)]"
          : "shadow-[inset_0_0_0_1px_var(--color-line)]",
      )}
    >
      <SummoningHeader
        name={hob.name}
        held={ready ? view.held : null}
        pending={pending}
        onSwitch={(next) => update.mutate(hobSwitchPayload(stored, everyHob, next))}
      />

      {on ? (
        <div className="flex animate-hb-in flex-col gap-4.5 ps-16 pe-4.5 pb-4.5">
          {view.held === "every-hob" && (
            <p className="m-0 rounded-control bg-notice px-3 py-2 text-detail text-text">
              {copy.fromEveryHob({ name: hob.name })}{" "}
              <Link
                to="/settings/$section"
                params={{ section: "connections" }}
                search={{ tab: "charms" }}
                className="text-link underline"
              >
                {copy.everyHobLink}
              </Link>
            </p>
          )}
          <SummoningSettings
            name={hob.name}
            self={hob.id}
            view={view}
            pending={pending}
            labels={{
              who: copy.who({ name: hob.name }),
              mayDo: copy.mayDo({ name: hob.name }),
              note: copy.note({ name: hob.name }),
            }}
            onEdit={(edit) => update.mutate(hobEditPayload(stored.policy, current, edit))}
            between={<SummonCapsSection hob={hob} />}
          />
        </div>
      ) : (
        <span className="animate-hb-in ps-16 pe-4.5 pb-4 text-ui text-text-secondary">
          {copy.off({ name: hob.name })}
        </span>
      )}
      <CardSaveOutcome hob={hob} save={update} failed={copy.saveFailed} />
    </section>
  );
}

/** The card's head: the Charm's mark, name and tag, what it does, and its switch, with blocks until it is known. */
function SummoningHeader({
  name,
  held,
  pending,
  onSwitch,
}: {
  name: string;
  /** Where the Charm comes from, or null while the hub reads it. */
  held: SummoningHeld | null;
  pending: boolean;
  onSwitch: (on: boolean) => void;
}) {
  const copy = messages.hob;
  const switchId = useId();
  const on = held !== null && held !== "off";
  return (
    <div className="flex items-center gap-3.5 px-4.5 py-4">
      <CharmMark off={!on} mark="✦" />
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="flex flex-wrap items-center gap-2">
          <label htmlFor={switchId} className="text-title font-bold text-text-strong">
            {copy.name}
          </label>
          {held === null ? (
            <Skeleton shape="block" surface="card" width="9ch" />
          ) : (
            <Badge variant={STATE_BADGE[held]}>{copy.state[held]}</Badge>
          )}
        </span>
        <span className="text-detail text-text-secondary">{on ? copy.on({ name }) : copy.offLine({ name })}</span>
      </div>
      {held === null ? (
        <Skeleton shape="dot" surface="card" className="h-6 w-[46px]" />
      ) : (
        <Switch
          id={switchId}
          aria-label={copy.grant({ name })}
          checked={on}
          disabled={pending}
          onCheckedChange={onSwitch}
        />
      )}
    </div>
  );
}
