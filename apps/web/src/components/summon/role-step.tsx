import { PICKER_FIRST, ROLE_FAMILIES, type RoleId, STARTER_ROLES, starterRole } from "@hobbots/domain";
import { Badge } from "@hobbots/ui/components/badge";
import { Button } from "@hobbots/ui/components/button";
import { useId, useState } from "react";
import { type FirstHobDraft, LABEL_MAX, pickRole, roleRequestUrl } from "../../api/first-hob.ts";
import { ChoresField, draftRolePicker, FIELD, SigilPicker } from "../hob-form.tsx";
import { RoleSheet } from "../role-sheet.tsx";
import { RoleSigil } from "../role-sigil.tsx";
import { messages } from "./messages.ts";
import { PickCard } from "./pick.tsx";
import { typeOwnTitle } from "./summon-model.ts";

const copy = messages.role;

type Update = (update: (draft: FirstHobDraft) => FirstHobDraft) => void;

/** A role's sigil on its dark tile, as the role cards and the picked row show it. */
function SigilTile({ sigil }: { sigil: RoleId }) {
  return (
    <span aria-hidden className="grid size-8 flex-none place-items-center rounded-control bg-tile">
      <RoleSigil sigil={sigil} size={24} />
    </span>
  );
}

/**
 * Step 1, what the hob helps with: the eight common roles as cards, every role in the role sheet,
 * or a title in the user's own words with a borrowed sigil, then the chores in their words.
 */
export function RoleStep({ draft, onChange, name }: { draft: FirstHobDraft; onChange: Update; name: string }) {
  const radios = useId();
  const [sheetOpen, setSheetOpen] = useState(false);
  const picked = draft.role !== null && !PICKER_FIRST.includes(draft.role) ? draft.role : null;
  return (
    <div className="flex flex-col gap-[18px]">
      <fieldset className="m-0 min-w-0 border-0 p-0">
        <legend className="sr-only">{copy.legend}</legend>
        <div className="grid grid-cols-2 gap-2.5 max-[720px]:grid-cols-1">
          {PICKER_FIRST.map((id) => {
            const role = starterRole(id);
            return (
              <PickCard
                key={id}
                name={radios}
                checked={draft.role === id}
                onPick={() => onChange((d) => pickRole(d, id))}
              >
                <SigilTile sigil={id} />
                <span className="flex min-w-0 flex-col">
                  <strong>{role.title}</strong>
                  <span className="text-detail text-text-secondary">{role.note}</span>
                </span>
              </PickCard>
            );
          })}
          {picked && <PickedRole role={picked} radios={radios} />}
        </div>
      </fieldset>

      <Button
        type="button"
        variant="outline"
        aria-haspopup="dialog"
        onClick={() => setSheetOpen(true)}
        className="self-start"
      >
        {copy.seeAll({ count: STARTER_ROLES.length })}
      </Button>
      {sheetOpen && <RoleSheet name={name} {...draftRolePicker(draft, onChange)} onClose={() => setSheetOpen(false)} />}

      <OwnTitle draft={draft} onChange={onChange} />

      <ChoresField draft={draft} onChange={onChange} rows={3} label={copy.chores} className="lbl text-label" />
      <a
        href={roleRequestUrl(draft.role === null ? draft.ownTitle : "")}
        target="_blank"
        rel="noreferrer"
        className="self-start text-detail"
      >
        {copy.suggest}
      </a>
    </div>
  );
}

/** A role picked from the sheet that is not among the eight, kept in view as the checked card. */
function PickedRole({ role, radios }: { role: RoleId; radios: string }) {
  const info = starterRole(role);
  const family = ROLE_FAMILIES.find((f) => f.id === info.family)?.title ?? "";
  return (
    <PickCard name={radios} checked onPick={() => {}} className="col-span-full animate-hb-in items-center">
      <SigilTile sigil={role} />
      <span className="flex min-w-0 flex-1 flex-col">
        <strong>{info.title}</strong>
        <span className="text-detail text-text-secondary">{info.note}</span>
      </span>
      <Badge variant="resting">{family}</Badge>
    </PickCard>
  );
}

/** "Or call it something of your own": a title in the user's words, then a sigil borrowed from any role. */
function OwnTitle({ draft, onChange }: { draft: FirstHobDraft; onChange: Update }) {
  const own = draft.role === null;
  return (
    <>
      <label className="flex flex-col gap-1.5">
        <span className="lbl text-label">{copy.ownLabel}</span>
        <input
          value={own ? draft.ownTitle : ""}
          maxLength={LABEL_MAX}
          onChange={(e) => {
            const title = e.target.value;
            onChange((d) => typeOwnTitle(d, title));
          }}
          placeholder={copy.ownPlaceholder}
          aria-label={copy.ownTitle}
          className={FIELD}
        />
      </label>
      {own && (
        <div className="flex animate-hb-in flex-col gap-2 rounded-card bg-card p-3.5">
          <SigilPicker
            value={draft.ownSigil}
            onPick={(ownSigil) => onChange((d) => ({ ...d, ownSigil }))}
            legend={<legend className="lbl mb-2 text-label">{copy.sigil}</legend>}
            className="grid grid-cols-[repeat(auto-fill,minmax(34px,1fr))] gap-1.5"
            tileClassName="aspect-square rounded-tag bg-tile p-[3px] data-on:shadow-[0_0_0_2px_var(--color-focus-ring)]"
          />
          <span className="text-detail text-label">{copy.sigilFrom({ role: starterRole(draft.ownSigil).title })}</span>
        </div>
      )}
    </>
  );
}
