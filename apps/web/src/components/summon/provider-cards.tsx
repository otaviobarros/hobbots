import type { RuntimeHealth, RuntimeKind } from "@hobbots/domain";
import { Skeleton } from "@hobbots/ui/components/skeleton";
import { cn } from "@hobbots/ui/lib/utils";
import { useId } from "react";
import { type BrainChoice, pickRuntime } from "../../api/first-hob.ts";
import { PROVIDER_MAKERS, PROVIDER_MARKS, PROVIDER_NAMES, PROVIDERS } from "../../lib/providers.ts";
import { messages } from "../messages.ts";
import { BlockedProviders, UnavailableProvider } from "../providers/provider-choices.tsx";
import { messages as settingsMessages } from "../settings/messages.ts";
import { PickCard } from "./pick.tsx";

const STATES = settingsMessages.providers.availability;

/** The provider's square mark in its color. */
function Mark({ runtime, className }: { runtime: RuntimeKind; className?: string }) {
  const look = PROVIDER_MARKS[runtime];
  return (
    <span
      aria-hidden
      className={cn(
        "grid size-[26px] flex-none place-items-center rounded-control text-detail font-bold text-provider-ink",
        look.tile,
        className,
      )}
    >
      {look.mark}
    </span>
  );
}

/**
 * Every AI the hub knows as a card, Claude first: a ready one to pick, and one that cannot think now
 * shown dimmed and unpickable, with how to fix it under the cards.
 */
export function ProviderCards<D extends BrainChoice>({
  runtimes,
  draft,
  onChange,
}: {
  runtimes: ReadonlyArray<RuntimeHealth>;
  draft: D;
  onChange: (draft: D) => void;
}) {
  const radios = useId();
  const listed = PROVIDERS.flatMap((runtime) => runtimes.filter((h) => h.runtime === runtime));
  const blocked = listed.filter((health) => health.availability !== "ready");
  return (
    <>
      <fieldset className="m-0 grid grid-cols-2 gap-2 border-0 p-0 max-[720px]:grid-cols-1">
        <legend className="sr-only">{messages.providerChoice.legend}</legend>
        {listed.map((health) => {
          const name = PROVIDER_NAMES[health.runtime];
          if (health.availability === "ready") {
            return (
              <PickCard
                key={health.runtime}
                name={radios}
                checked={draft.runtime === health.runtime}
                onPick={() => onChange(pickRuntime(draft, health.runtime))}
                label={name}
                className="items-center gap-2.5 px-2.5 py-2"
              >
                <Mark runtime={health.runtime} />
                <span className="flex min-w-0 flex-col">
                  <strong>{name}</strong>
                  <span className="truncate text-meta text-text-secondary">{PROVIDER_MAKERS[health.runtime]}</span>
                </span>
              </PickCard>
            );
          }
          return (
            <UnavailableProvider
              key={health.runtime}
              health={health}
              name={radios}
              className="flex min-w-0 cursor-not-allowed items-center gap-2.5 rounded-control border border-dashed border-line-2 px-2.5 py-2 text-label"
            >
              <Mark runtime={health.runtime} className="opacity-60" />
              <span className="flex min-w-0 flex-col">
                <strong className="text-text-secondary">{name}</strong>
                <span className="text-meta text-lantern">{STATES[health.availability]}</span>
              </span>
            </UnavailableProvider>
          );
        })}
      </fieldset>
      <BlockedProviders blocked={blocked} className="text-text-secondary [&_b]:text-text-strong" />
    </>
  );
}

/**
 * The provider cards while the hub checks them: each provider's mark and name in its card, with a
 * block where its state goes, so the cards do not move when the check lands.
 */
export function ProviderCardsWaiting() {
  return (
    <div className="grid grid-cols-2 gap-2 max-[720px]:grid-cols-1">
      {PROVIDERS.map((runtime) => (
        <span
          key={runtime}
          className="flex min-w-0 items-center gap-2.5 rounded-control bg-card px-2.5 py-2 text-text-strong"
        >
          <Mark runtime={runtime} />
          <span className="flex min-w-0 flex-col">
            <strong>{PROVIDER_NAMES[runtime]}</strong>
            <span className="text-meta">
              <Skeleton width="14ch" surface="card" />
            </span>
          </span>
        </span>
      ))}
    </div>
  );
}
