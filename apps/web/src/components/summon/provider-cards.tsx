import type { RuntimeHealth } from "@hobbots/domain";
import { cn } from "@hobbots/ui/lib/utils";
import { useId } from "react";
import { type BrainChoice, pickRuntime } from "../../api/first-hob.ts";
import { PROVIDER_MAKERS, PROVIDER_MARKS, PROVIDER_NAMES, PROVIDERS } from "../../lib/providers.ts";
import { messages } from "../messages.ts";
import { BlockedProviders, UnavailableProvider } from "../provider-choices.tsx";
import { messages as settingsMessages } from "../settings/messages.ts";
import { PickCard } from "./pick.tsx";

const STATES = settingsMessages.providers.availability;

/** The provider's square mark in its color. */
function Mark({ health, className }: { health: RuntimeHealth; className?: string }) {
  const look = PROVIDER_MARKS[health.runtime];
  return (
    <span
      aria-hidden
      className={cn(
        "grid size-[26px] flex-none place-items-center rounded-control text-detail font-bold text-ground",
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
                <Mark health={health} />
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
              <Mark health={health} className="opacity-60" />
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
