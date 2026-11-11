import type { BrainGroup } from "./brain.ts";
import type { ChoiceOption } from "./model.ts";

/**
 * A model list that scales to any number of runtimes: a native select, its models grouped by
 * provider, then any choice outside the groups, such as Same or No AI.
 */
export function ModelSelect({
  id,
  label,
  value,
  groups = [],
  options = [],
  disabled,
  onPick,
}: {
  id?: string;
  label: string;
  value: string;
  groups?: ReadonlyArray<BrainGroup>;
  options?: ReadonlyArray<ChoiceOption<string>>;
  disabled: boolean;
  onPick: (value: string) => void;
}) {
  const option = (each: ChoiceOption<string>) => (
    <option key={each.value} value={each.value} disabled={each.unavailable !== undefined}>
      {each.label}
    </option>
  );
  return (
    <select
      id={id}
      aria-label={label}
      value={value}
      disabled={disabled}
      onChange={(event) => onPick(event.target.value)}
      className="min-w-0 max-w-full rounded-control border-(length:--edge) border-control bg-deep px-2 py-1 text-detail text-text-strong disabled:opacity-60"
    >
      {groups.map((group) => (
        <optgroup key={group.label} label={group.label}>
          {group.options.map(option)}
        </optgroup>
      ))}
      {options.map(option)}
    </select>
  );
}
