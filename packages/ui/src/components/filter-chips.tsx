import { cn } from "cn";
import { ToggleGroup as ToggleGroupPrimitive } from "radix-ui";
import type * as React from "react";

// A row of filter chips: each chip is a pill with a label and, for a filter, a count. Exactly one is picked.
// The picked chip is inverted. Built on the Radix toggle group, so the row is one tab stop, arrow
// keys move between chips, and Space or Enter picks one.
function FilterChips({
  className,
  value,
  onValueChange,
  ...props
}: Omit<React.ComponentProps<typeof ToggleGroupPrimitive.Root>, "type" | "value" | "defaultValue" | "onValueChange"> & {
  value: string;
  onValueChange: (value: string) => void;
}) {
  return (
    <ToggleGroupPrimitive.Root
      data-slot="filter-chips"
      type="single"
      value={value}
      // A row always has one chip picked, so pressing the picked chip again keeps it.
      onValueChange={(next) => {
        if (next !== "") onValueChange(next);
      }}
      className={cn("flex flex-wrap items-center gap-1.5", className)}
      {...props}
    />
  );
}

function FilterChip({
  className,
  count,
  children,
  ...props
}: React.ComponentProps<typeof ToggleGroupPrimitive.Item> & {
  /** How many items the chip leaves, or undefined for a chip that picks a value, such as a hat. */
  count?: React.ReactNode;
}) {
  return (
    <ToggleGroupPrimitive.Item
      data-slot="filter-chip"
      className={cn(
        "group/filter-chip inline-flex h-8.5 shrink-0 cursor-pointer items-center gap-2 rounded-full border-(length:--edge) border-line-2 bg-transparent py-0 ps-3.5 text-sm whitespace-nowrap text-text-secondary outline-none hover:border-control hover:text-text-strong focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-ground disabled:cursor-not-allowed disabled:opacity-50 data-[state=on]:border-text-strong data-[state=on]:bg-text-strong data-[state=on]:text-ground",
        count === undefined ? "pe-3.5" : "pe-1.5",
        className,
      )}
      {...props}
    >
      {children}
      {count !== undefined && (
        <span
          data-slot="filter-chip-count"
          className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-text-strong/11 px-1.5 text-xs font-semibold text-text-secondary tabular-nums group-data-[state=on]/filter-chip:bg-ground group-data-[state=on]/filter-chip:text-text-strong"
        >
          {count}
        </span>
      )}
    </ToggleGroupPrimitive.Item>
  );
}

export { FilterChip, FilterChips };
