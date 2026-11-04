import { Switch as SwitchPrimitive } from "radix-ui";
import type * as React from "react";
import { cn } from "../lib/utils.ts";

// The Hobbots switch from the component sheet: 46×24 with the skin's edge and dot corner, so it is
// round with a 1px edge in Lamplight and square with a 2px edge in Workshop. The track is line when
// off and mint-deep, border included, when on. The knob eases across in Lamplight and steps in
// Workshop, and stays put with Reduce motion. The knob of an on switch is the light switch-knob
// color in every theme, so it stays readable on mint-deep in the light themes too. Focus is the
// skin's control focus: an outline in Lamplight, drawn inset in Workshop. The switch sits before
// its label, which names it.
function Switch({ className, ...props }: React.ComponentProps<typeof SwitchPrimitive.Root>) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn(
        "relative inline-flex h-6 w-[46px] shrink-0 cursor-pointer rounded-dot border-(length:--edge) border-solid border-control bg-line p-0 transition-colors duration-(--dur-fade) ease-(--ease-ui) outline-none motion-reduce:transition-none focus-visible:shadow-(--control-focus-ring) focus-visible:[outline:var(--control-focus-outline)] focus-visible:outline-offset-2 disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:border-mint-deep data-[state=checked]:bg-mint-deep",
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className="absolute top-0.5 start-0.5 size-[calc(20px-2*var(--edge))] rounded-dot bg-text-strong transition-[inset-inline-start] duration-(--dur-fade) ease-(--ease-ui) motion-reduce:transition-none data-[state=checked]:start-6 data-[state=checked]:bg-switch-knob"
      />
    </SwitchPrimitive.Root>
  );
}

export { Switch };
