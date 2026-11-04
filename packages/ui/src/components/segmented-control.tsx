import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "cn";
import { ToggleGroup } from "radix-ui";
import * as React from "react";

// A segmented control (docs/design/ui-ux.md): one choice from a few, on a sunken track. Built from
// the shadcn Toggle Group, kept to a single choice so one segment is always on.
//
// Corners read the `--corner-control` skin variable. The track's corner is the segment's scaled to
// cover its 3px padding (8px gives 11px), so it stays square when the segment is square.

const segmentVariants = cva(
  "inline-flex shrink-0 cursor-pointer items-center justify-center gap-1.5 rounded-control border-0 bg-transparent whitespace-nowrap text-text-secondary transition-colors duration-150 outline-none select-none hover:text-text-strong focus-visible:z-10 focus-visible:shadow-[inset_0_0_0_2px_var(--color-ring)] disabled:pointer-events-none disabled:opacity-50 data-[state=on]:bg-card data-[state=on]:text-text-strong data-[state=on]:shadow-[0_1px_2px_rgb(0_0_0/0.18)] data-[state=on]:focus-visible:shadow-[inset_0_0_0_2px_var(--color-ring)] [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      size: {
        default: "px-2.5 py-1.5 text-sm leading-5",
        sm: "px-2.5 py-[3px] text-detail leading-[18px]",
      },
    },
    defaultVariants: { size: "default" },
  },
);

type SegmentSize = VariantProps<typeof segmentVariants>["size"];

const SegmentedControlContext = React.createContext<{ size: SegmentSize }>({ size: "default" });

type SegmentedControlProps<Value extends string> = Omit<
  React.ComponentProps<typeof ToggleGroup.Root>,
  "type" | "value" | "defaultValue" | "onValueChange"
> & {
  /** The segment that is on, or null while none is, such as before the first pick. */
  value: Value | null;
  /**
   * Called with the segment that was picked. Picking the segment that is already on calls it
   * again with the same value, so a caller can treat a repeat pick as it needs.
   */
  onValueChange: (value: Value) => void;
  size?: SegmentSize;
  /** The group's accessible name, such as "Attempts" or "Show as". */
  "aria-label": string;
};

function SegmentedControl<Value extends string>({
  className,
  value,
  onValueChange,
  size = "default",
  children,
  ...props
}: SegmentedControlProps<Value>) {
  return (
    <ToggleGroup.Root
      data-slot="segmented-control"
      data-size={size}
      type="single"
      value={value ?? ""}
      // Radix sends "" when the segment that is on is picked again; that keeps it on.
      onValueChange={(next: string) => {
        const picked = next === "" ? value : (next as Value);
        if (picked !== null) onValueChange(picked);
      }}
      className={cn(
        "flex w-fit max-w-full flex-row items-center gap-0.5 overflow-x-auto rounded-[calc(var(--corner-control)*11/8)] bg-deep p-[3px]",
        className,
      )}
      {...props}
    >
      <SegmentedControlContext.Provider value={{ size }}>{children}</SegmentedControlContext.Provider>
    </ToggleGroup.Root>
  );
}

function SegmentedControlItem({ className, ...props }: React.ComponentProps<typeof ToggleGroup.Item>) {
  const { size } = React.useContext(SegmentedControlContext);
  return (
    <ToggleGroup.Item
      data-slot="segmented-control-item"
      className={cn(segmentVariants({ size }), className)}
      {...props}
    />
  );
}

export { SegmentedControl, SegmentedControlItem };
