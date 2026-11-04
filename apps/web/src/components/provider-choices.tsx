import { RUNTIME_NAMES, type RuntimeHealth, type RuntimeKind } from "@hobbots/domain";
import { cn } from "@hobbots/ui/lib/utils";
import { type BrainChoice, pickRuntime } from "../api/first-hob.ts";
import { PROVIDER_MARKS, PROVIDER_NAMES, PROVIDERS } from "../lib/providers.ts";
import { Choice } from "./hob-form.tsx";
import { messages } from "./messages.ts";
import { ProviderFixActions, providerFix } from "./provider-fix.tsx";
import { messages as settingsMessages } from "./settings/messages.ts";

const copy = messages.providerChoice;
const STATES = settingsMessages.providers.availability;

/** The provider's square mark in its color. */
function ProviderMark({ runtime, className }: { runtime: RuntimeKind; className?: string | undefined }) {
  const look = PROVIDER_MARKS[runtime];
  return (
    <span
      aria-hidden
      className={cn(
        "grid size-4 flex-none place-items-center text-[11px] font-bold text-provider-ink",
        look.tile,
        className,
      )}
    >
      {look.mark}
    </span>
  );
}

/** Why the provider cannot think now and how to fix it, in its own words. */
const whyNot = (health: RuntimeHealth) =>
  providerFix(health.runtime, health) ?? messages.brain.notOnThisHub({ runtime: RUNTIME_NAMES[health.runtime] });

/**
 * The providers a hob can think with: each ready one to pick, and each one that cannot think now
 * shown as unavailable, unpickable, with how to fix it. Picking another provider leaves its model
 * and effort to its own list (ADR 024). `only` narrows the list, as onboarding does to the
 * providers the user connected.
 */
export function ProviderChoices<D extends BrainChoice>({
  runtimes,
  draft,
  onChange,
  only,
  chipClassName,
  markClassName,
}: {
  runtimes: ReadonlyArray<RuntimeHealth>;
  draft: D;
  onChange: (draft: D) => void;
  only?: ReadonlyArray<RuntimeKind> | undefined;
  chipClassName?: string | undefined;
  markClassName?: string | undefined;
}) {
  const listed = PROVIDERS.flatMap((runtime) => {
    const health = runtimes.find((h) => h.runtime === runtime);
    return health && (only?.includes(runtime) ?? true) ? [health] : [];
  });
  const blocked = listed.filter((health) => health.availability !== "ready");
  return (
    <div className="flex flex-col gap-1.5">
      <fieldset className="m-0 flex flex-wrap gap-1.5 border-0 p-0">
        <legend className="sr-only">{copy.legend}</legend>
        {listed.map((health) => {
          const name = PROVIDER_NAMES[health.runtime];
          if (health.availability === "ready") {
            return (
              <Choice
                key={health.runtime}
                name="hob-provider"
                checked={draft.runtime === health.runtime}
                onPick={() => onChange(pickRuntime(draft, health.runtime))}
                label={name}
                className={chipClassName}
              >
                <ProviderMark runtime={health.runtime} className={markClassName} />
                {name}
              </Choice>
            );
          }
          const state = STATES[health.availability];
          return (
            <label
              key={health.runtime}
              className={cn(
                "cut flex cursor-not-allowed items-center gap-2 border-2 border-dashed border-line-2 px-3 py-[7px] text-sm text-label",
                chipClassName,
              )}
            >
              <input
                type="radio"
                name="hob-provider"
                disabled
                checked={false}
                onChange={() => {}}
                aria-label={copy.unavailable({ provider: name, state })}
                className="sr-only"
              />
              <ProviderMark runtime={health.runtime} className={cn("opacity-60", markClassName)} />
              {name}
              <span className="text-xs text-lantern">{state}</span>
            </label>
          );
        })}
      </fieldset>
      {blocked.map((health) => (
        <div
          key={health.runtime}
          role="status"
          aria-label={`${PROVIDER_NAMES[health.runtime]}: ${STATES[health.availability]}`}
          className="flex flex-col text-[13px] leading-snug text-lantern"
        >
          <span>
            <b>{PROVIDER_NAMES[health.runtime]}</b> · {whyNot(health)}
          </span>
          <ProviderFixActions
            runtime={health.runtime}
            notFound={health.availability === "unavailable" && health.version === null}
            size="xs"
            className="mt-1"
          />
        </div>
      ))}
    </div>
  );
}
