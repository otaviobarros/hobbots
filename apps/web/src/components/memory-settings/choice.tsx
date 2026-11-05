import { SegmentedControl, SegmentedControlItem } from "@hobbots/ui/components/segmented-control";
import type { ChoiceOption } from "./model.ts";

/** A segmented choice whose unavailable segments say why on hover. */
export function Choice<Value extends string>({
  label,
  value,
  options,
  disabled,
  onPick,
}: {
  label: string;
  value: Value;
  options: ReadonlyArray<ChoiceOption<Value>>;
  disabled: boolean;
  onPick: (value: Value) => void;
}) {
  return (
    <SegmentedControl size="sm" aria-label={label} value={value} onValueChange={onPick}>
      {options.map((option) => (
        <SegmentedControlItem
          key={option.value}
          value={option.value}
          disabled={disabled || option.unavailable !== undefined}
          title={option.unavailable ?? option.label}
        >
          {option.label}
        </SegmentedControlItem>
      ))}
    </SegmentedControl>
  );
}
