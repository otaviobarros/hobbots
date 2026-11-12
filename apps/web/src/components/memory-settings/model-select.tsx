import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSelectTrigger,
  DropdownMenuSeparator,
} from "@hobbots/ui/components/menu";
import { Fragment } from "react";
import type { BrainGroup } from "./brain.ts";
import { messages } from "./messages.ts";
import type { ChoiceOption } from "./model.ts";

const copy = messages.brain;

/**
 * A model list that scales to any number of runtimes, in Hobbots' own menu: a button naming the
 * choice, opening its models grouped by provider, then any choice outside the groups, such as Same
 * or No AI, with a check on the chosen one.
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
  const all = [...groups.flatMap((group) => group.options), ...options];
  const current = all.find((option) => option.value === value)?.label ?? value;
  const item = (each: ChoiceOption<string>) => (
    <DropdownMenuRadioItem
      key={each.value}
      value={each.value}
      disabled={each.unavailable !== undefined}
      title={each.unavailable}
    >
      {each.label}
    </DropdownMenuRadioItem>
  );
  return (
    <DropdownMenu>
      <DropdownMenuSelectTrigger id={id} aria-label={copy.list({ label, choice: current })} disabled={disabled}>
        {current}
      </DropdownMenuSelectTrigger>
      <DropdownMenuContent aria-label={label} look="list">
        <DropdownMenuRadioGroup value={value} onValueChange={onPick}>
          {groups.map((group, index) => (
            <Fragment key={group.label}>
              {index > 0 && <DropdownMenuSeparator />}
              <DropdownMenuLabel>{group.label}</DropdownMenuLabel>
              {group.options.map(item)}
            </Fragment>
          ))}
          {groups.length > 0 && options.length > 0 && <DropdownMenuSeparator />}
          {options.map(item)}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
