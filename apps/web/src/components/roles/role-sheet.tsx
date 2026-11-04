import { ROLE_FAMILIES, type RoleFamily, type RoleId, STARTER_ROLES, starterRole } from "@hobbots/domain";
import { Button } from "@hobbots/ui/components/button";
import { Dialog, DialogClose, DialogContent, DialogTitle } from "@hobbots/ui/components/dialog";
import { cn } from "@hobbots/ui/lib/utils";
import { useId, useState } from "react";
import { roleGroups, roleRequestUrl } from "../../api/first-hob.ts";
import { OwnRole, RadioLabel, type RolePick } from "../hob-form/hob-form.tsx";
import { RoleSigil } from "./role-sigil.tsx";

const copy = {
  title: "Pick a role",
  families: "Role families",
  all: "All roles",
  own: "Your own",
  ownNote: "Give it a title in your words and pick a sigil.",
  suggest: "Missing a role? Suggest one",
  cancel: "Cancel",
  close: "Close",
  pick: ({ role }: { role: string }) => `Pick ${role}`,
  pickOwn: "Use your own title",
};

const OPTION =
  "flex min-w-0 cursor-pointer items-start gap-3 rounded-control bg-card p-3 text-left text-text-strong transition-colors duration-150 hover:bg-hover has-checked:shadow-[inset_0_0_0_2px_var(--color-focus-ring)] has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-focus-ring";

/**
 * The role dialog, for Summon and for the profile's Change role: the families on the left with
 * their counts, the family's roles as two columns of cards, and a footer with the picked role's
 * note, Cancel and Pick. "Your own" closes the list for a title in the user's words. Nothing
 * changes until Pick, so Cancel, Escape and Close leave the hob as it was. It is the shared
 * dialog, so focus stays inside it and goes back where it was when it closes.
 */
export function RoleSheet({
  value,
  onPick,
  onOwnTitle,
  onOwnSigil,
  onClose,
}: {
  /** The hob's name; the dialog's words do not use it, but callers pass it for its title one day. */
  name?: string;
  value: RolePick;
  onPick: (role: RoleId | null) => void;
  onOwnTitle: (title: string) => void;
  onOwnSigil: (sigil: RoleId) => void;
  onClose: () => void;
}) {
  const radios = useId();
  const [family, setFamily] = useState<RoleFamily | "all">(() =>
    value.role === null ? "all" : starterRole(value.role).family,
  );
  const [pending, setPending] = useState<RolePick>(value);
  const [ownPicked, setOwnPicked] = useState(false);
  const groups = roleGroups("", family);
  const own = pending.role === null;
  const confirm = () => {
    if (own) {
      onPick(null);
      onOwnTitle(pending.ownTitle);
      onOwnSigil(pending.ownSigil);
    } else onPick(pending.role);
    onClose();
  };
  const note = own ? copy.ownNote : starterRole(pending.role as RoleId).note;
  const canPick = !own || pending.ownTitle.trim() !== "";

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        aria-describedby={undefined}
        className="h-[min(640px,calc(100vh-48px))] w-[min(920px,calc(100vw-32px))] max-w-none animate-hb-in gap-0 overflow-hidden rounded-card border-0 bg-panel p-0 shadow-sheet"
      >
        <div className="flex items-center gap-3 border-b border-line px-5 py-4">
          <DialogTitle className="m-0 flex-1 font-heading text-heading font-(--heading-weight)">
            {copy.title}
          </DialogTitle>
          <DialogClose asChild>
            <Button type="button" variant="ghost" size="icon" aria-label={copy.close}>
              ×
            </Button>
          </DialogClose>
        </div>

        <div className="flex min-h-0 flex-1 max-[720px]:flex-col">
          <nav
            aria-label={copy.families}
            className="flex w-[244px] flex-none flex-col gap-0.5 overflow-y-auto border-e border-line p-3 max-[720px]:w-full max-[720px]:flex-row max-[720px]:flex-wrap max-[720px]:border-e-0 max-[720px]:border-b"
          >
            {[{ id: "all" as const, title: copy.all }, ...ROLE_FAMILIES].map((f) => (
              <button
                key={f.id}
                type="button"
                aria-pressed={family === f.id}
                onClick={() => setFamily(f.id)}
                className={cn(
                  "flex min-h-9 cursor-pointer items-center gap-2 rounded-control border-0 px-2.5 text-start text-sm text-text-strong hover:bg-hover",
                  family === f.id ? "bg-card" : "bg-transparent",
                )}
              >
                <span className="flex-1">{f.title}</span>
                <span className="text-meta text-label">
                  {f.id === "all" ? STARTER_ROLES.length : roleGroups("", f.id)[0]?.roles.length}
                </span>
              </button>
            ))}
          </nav>

          <fieldset className="m-0 flex min-h-0 min-w-0 flex-1 flex-col gap-4 overflow-y-auto border-0 p-5">
            <legend className="sr-only">Role</legend>
            {groups.map((group) => (
              <section key={group.family} aria-label={group.title} className="flex flex-col gap-2">
                <h3 className="lbl m-0 text-label">{group.title}</h3>
                <div className="grid grid-cols-2 gap-2 max-[720px]:grid-cols-1">
                  {group.roles.map((id) => {
                    const role = starterRole(id);
                    return (
                      <RadioLabel
                        key={id}
                        name={radios}
                        checked={pending.role === id}
                        onPick={() => setPending((p) => ({ ...p, role: id }))}
                        className={OPTION}
                      >
                        <span aria-hidden className="grid size-8 flex-none place-items-center rounded-control bg-tile">
                          <RoleSigil sigil={id} size={24} />
                        </span>
                        <span className="flex min-w-0 flex-col">
                          <strong>{role.title}</strong>
                          <span className="text-detail text-text-secondary">{role.note}</span>
                        </span>
                      </RadioLabel>
                    );
                  })}
                </div>
              </section>
            ))}
            <section aria-label={copy.own} className="flex flex-col gap-2">
              <RadioLabel
                name={radios}
                checked={own}
                onPick={() => {
                  setOwnPicked(true);
                  setPending((p) => ({ ...p, role: null }));
                }}
                className={cn(OPTION, "max-w-[340px]", !own && "border border-dashed border-line-2")}
              >
                <span
                  aria-hidden
                  className="grid size-8 flex-none place-items-center rounded-control border border-dashed border-control text-label"
                >
                  +
                </span>
                <span className="flex min-w-0 flex-col">
                  <strong>{copy.own}</strong>
                  <span className="text-detail text-text-secondary">{copy.ownNote}</span>
                </span>
              </RadioLabel>
              {own && (
                <OwnRole
                  value={pending}
                  onTitle={(ownTitle) => setPending((p) => ({ ...p, ownTitle }))}
                  onSigil={(ownSigil) => setPending((p) => ({ ...p, ownSigil }))}
                  autoFocus={ownPicked}
                />
              )}
              <a
                href={roleRequestUrl(own ? pending.ownTitle : "")}
                target="_blank"
                rel="noreferrer"
                className="self-start text-detail text-link underline underline-offset-3"
              >
                {copy.suggest}
              </a>
            </section>
          </fieldset>
        </div>

        <div className="flex flex-wrap items-center gap-3 border-t border-line px-5 py-3.5">
          <span className="min-w-0 flex-1 truncate text-detail text-text-secondary">{note}</span>
          <Button type="button" variant="outline" onClick={onClose}>
            {copy.cancel}
          </Button>
          <Button type="button" onClick={confirm} disabled={!canPick}>
            {own ? copy.pickOwn : copy.pick({ role: starterRole(pending.role as RoleId).title })}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
