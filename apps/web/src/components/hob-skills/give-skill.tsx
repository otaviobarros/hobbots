import { skillRevisionLabel } from "@hobbots/domain";
import { Button } from "@hobbots/ui/components/button";
import { RowList } from "../memory/memory-overview.tsx";
import { type HobDirectory, scopeName, skillTitle } from "../skills/skills-model.ts";
import { RevTag } from "../skills/skills-parts.tsx";
import type { GiveOffer } from "./hob-skills-model.ts";
import { messages } from "./messages.ts";

const copy = messages.picker;

/** Where an offered skill is given now, as its row says it, then the start of what it is for. */
const subOf = (offer: GiveOffer, name: string, hobs: HobDirectory) => {
  if (offer._tag === "TurnOn") return copy.offFor({ scope: scopeName(offer.scope, hobs), name });
  const where = offer.given.length === 0 ? copy.notGiven : offer.given.map((scope) => scopeName(scope, hobs)).join(", ");
  return `${where} · ${offer.skill.description}`;
};

/**
 * The library's skills a hob does not carry, to give it one (ADR 029, A hob's Skills tab): the same
 * picker on its Skills tab, its profile and Summon. Each row's action is the caller's, so Summon can
 * pick skills for a hob that does not exist yet.
 */
export function GiveSkill({
  name,
  offers,
  hobs,
  empty,
  failure,
  onClose,
  action,
}: {
  name: string;
  offers: ReadonlyArray<GiveOffer>;
  hobs: HobDirectory;
  /** What to say when there is nothing to offer. */
  empty: string;
  failure: string | null;
  onClose: () => void;
  action: (offer: GiveOffer) => React.ReactNode;
}) {
  return (
    <section aria-label={copy.title({ name })} className="flex flex-col gap-2.5 rounded-card bg-card p-4">
      <header className="flex items-center gap-2">
        <h3 className="m-0 flex-1 font-heading text-[16px] leading-[22px] font-bold text-text-strong">
          {copy.title({ name })}
        </h3>
        <Button type="button" variant="ghost" size="sm" onClick={onClose}>
          {copy.close}
        </Button>
      </header>
      {offers.length === 0 ? (
        <p className="m-0 text-ui text-text-secondary">{empty}</p>
      ) : (
        <RowList label={copy.title({ name })}>
          {offers.map((offer) => (
            <li key={offer.skill.id} className="flex items-center gap-2.5 bg-panel px-3 py-2.5">
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="flex items-center gap-2">
                  <span className="truncate text-ui font-semibold text-text-strong">
                    {skillTitle(offer.skill.name)}
                  </span>
                  <RevTag label={skillRevisionLabel({ number: offer.skill.revisions })} />
                </span>
                <span className="truncate text-meta text-label">{subOf(offer, name, hobs)}</span>
              </span>
              {action(offer)}
            </li>
          ))}
        </RowList>
      )}
      {failure !== null && (
        <p role="alert" className="m-0 text-ui text-rose">
          {failure}
        </p>
      )}
      <p className="m-0 text-detail text-label">{copy.foot({ name })}</p>
    </section>
  );
}
