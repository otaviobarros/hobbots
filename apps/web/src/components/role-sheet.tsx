import { ROLE_FAMILIES, type RoleFamily, type RoleId, starterRole } from "@hobbots/domain";
import { Button } from "@hobbots/ui/components/button";
import { cn } from "@hobbots/ui/lib/utils";
import { useEffect, useId, useRef, useState } from "react";
import { roleGroups, roleRequestUrl } from "../api/first-hob.ts";
import { Choice, OwnRole, RoleOption, type RolePick } from "./hob-form.tsx";

/**
 * Every starter role in one sheet, for changing a hob's role from its profile: a search over titles
 * and notes, a filter per family, the roles in four columns, and "Your own". A pick applies to the
 * draft at once, so the profile's card follows it; the profile's save bar still decides when it is
 * saved. A native modal dialog keeps focus inside it and closes on Escape.
 */
export function RoleSheet({
  name,
  value,
  onPick,
  onOwnTitle,
  onOwnSigil,
  onClose,
}: {
  name: string;
  value: RolePick;
  onPick: (role: RoleId | null) => void;
  onOwnTitle: (title: string) => void;
  onOwnSigil: (sigil: RoleId) => void;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const radios = useId();
  const families = useId();
  const [search, setSearch] = useState("");
  const [family, setFamily] = useState<RoleFamily | "all">("all");
  const [ownPicked, setOwnPicked] = useState(false);
  const groups = roleGroups(search, family);
  const own = value.role === null;
  const picked = own ? value.ownTitle.trim() || "Your own" : starterRole(value.role).title;

  useEffect(() => {
    const element = dialog.current;
    if (element && !element.open) element.showModal();
  }, []);

  return (
    <dialog
      ref={dialog}
      aria-labelledby={titleId}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      className="cut m-auto h-[min(720px,calc(100vh-48px))] w-[min(1000px,calc(100vw-32px))] animate-hb-in flex-col border-2 border-control bg-panel p-0 open:flex text-text backdrop:bg-deep/80"
    >
      <div className="flex flex-wrap items-center gap-3.5 border-b-2 border-line px-5 py-4">
        <h2 id={titleId} className="m-0 flex-1 font-pixel text-[22px] font-bold text-moonlight">
          Choose {name}'s role
        </h2>
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          aria-label="Find a role"
          placeholder="Find a role, like “taxes” or “code”"
          className="w-[340px] max-w-full border-2 border-control bg-deep px-3 py-2 text-text placeholder:text-label"
        />
      </div>

      <fieldset className="m-0 flex flex-wrap gap-1.5 border-0 border-b-2 border-line px-5 py-3">
        <legend className="sr-only">Show roles from</legend>
        {[{ id: "all" as const, title: "All roles" }, ...ROLE_FAMILIES].map((f) => (
          <Choice
            key={f.id}
            name={families}
            checked={family === f.id}
            onPick={() => setFamily(f.id)}
            className="px-2.5 py-1 text-[13px]"
          >
            {f.title}
          </Choice>
        ))}
      </fieldset>

      <fieldset className="m-0 flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto border-0 px-5 py-4">
        <legend className="sr-only">Role</legend>
        {groups.length === 0 && (
          <p role="status" className="m-0 text-sm text-secondary-text">
            No role matches “{search.trim()}”. Give {name} a title of your own below, or suggest the role.
          </p>
        )}
        {groups.map((group) => (
          <section key={group.family} aria-label={group.title} className="flex flex-col gap-2">
            <h3 className="lbl m-0 text-xs text-label">{group.title}</h3>
            <div className="grid grid-cols-4 gap-1.5 max-[900px]:grid-cols-2">
              {group.roles.map((id) => {
                const role = starterRole(id);
                return (
                  <RoleOption
                    key={id}
                    name={radios}
                    checked={value.role === id}
                    onPick={() => onPick(id)}
                    sigil={id}
                    title={role.title}
                    note={role.note}
                  />
                );
              })}
            </div>
          </section>
        ))}
        <section aria-label="Your own" className="flex flex-col gap-2">
          <RoleOption
            name={radios}
            checked={own}
            onPick={() => {
              setOwnPicked(true);
              onPick(null);
            }}
            sigil={own ? value.ownSigil : null}
            title="Your own"
            note="Give it a title in your words and pick a sigil."
            className={cn("max-w-[320px]", !own && "border-dashed")}
          />
          {own && <OwnRole value={value} onTitle={onOwnTitle} onSigil={onOwnSigil} autoFocus={ownPicked} />}
          <a
            href={roleRequestUrl(own ? value.ownTitle : search)}
            target="_blank"
            rel="noreferrer"
            className="self-start text-[13px]"
          >
            Missing a role? Suggest one
          </a>
        </section>
      </fieldset>

      <div className="flex items-center gap-3 border-t-2 border-line px-5 py-3.5">
        <span className="flex-1 text-sm text-secondary-text">
          {name} is told its role before every reply. A role changes how {name} looks and works, never what {name} may
          do.
        </span>
        <Button type="button" onClick={onClose}>
          Use {picked}
        </Button>
      </div>
    </dialog>
  );
}
