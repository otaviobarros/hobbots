import { type Agent, type MemoryProjectIdentity, memoryScopeKey, type SkillScope } from "@hobbots/domain";
import { cn } from "@hobbots/ui/lib/utils";
import { messages } from "./messages.ts";
import { projectName } from "./skills-model.ts";

const copy = messages;

/** Who a new skill goes to: nobody yet, Everyone, a project, or one hob. */
export type GiveTo = SkillScope | null;

const keyOf = (give: GiveTo) => (give === null ? "none" : memoryScopeKey(give));

/** The choice of who gets a skill you add, as radio buttons. */
export function GiveChoice({
  value,
  onChange,
  active,
  projects,
  many = false,
  legend,
}: {
  value: GiveTo;
  onChange: (give: GiveTo) => void;
  active: ReadonlyArray<Agent>;
  projects: ReadonlyArray<MemoryProjectIdentity>;
  many?: boolean;
  /** What the choice is called, when not "Give it to" or "Give them to": a set's reads "Give the set to". */
  legend?: string;
}) {
  const options: ReadonlyArray<{ give: GiveTo; label: string; sub: string }> = [
    { give: null, label: copy.giveChoice.nobody, sub: copy.giveChoice.nobodySub },
    { give: { _tag: "Everyone" }, label: copy.giveChoice.everyone, sub: copy.giveChoice.everyoneSub },
    ...projects.map((identity) => ({
      give: { _tag: "Project", identity } as const,
      label: copy.giveChoice.project({ name: projectName(identity) }),
      sub: copy.giveChoice.projectSub,
    })),
    ...active.map((hob) => ({
      give: { _tag: "Hob", agentId: hob.id } as const,
      label: hob.name,
      sub: copy.giveChoice.hobSub,
    })),
  ];
  const chosen = keyOf(value);
  return (
    <fieldset className="m-0 flex flex-col gap-1.5 border-0 p-0">
      <legend className="lbl pb-1.5 text-meta text-label">
        {legend ?? (many ? copy.giveChoice.legendMany : copy.giveChoice.legend)}
      </legend>
      <div className="grid grid-cols-3 gap-2 max-[900px]:grid-cols-1">
        {options.map((option) => {
          const key = keyOf(option.give);
          const on = key === chosen;
          return (
            <label
              key={key}
              className={cn(
                "flex cursor-pointer items-center gap-2.5 rounded-card bg-card px-3 py-2.5 hover:bg-hover",
                on && "shadow-[inset_0_0_0_1px_var(--color-focus-ring)]",
              )}
            >
              <input
                type="radio"
                name="give-to"
                checked={on}
                onChange={() => onChange(option.give)}
                className="size-4 accent-(--color-focus-ring)"
              />
              <span className="flex min-w-0 flex-col">
                <span className="truncate text-ui text-text-strong">{option.label}</span>
                <span className="text-meta text-label">{option.sub}</span>
              </span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}
