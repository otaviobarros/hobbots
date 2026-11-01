import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "cn";
import { Toast as ToastPrimitive } from "radix-ui";
import type * as React from "react";

// Hobbots toasts (docs/design/ui-ux.md): a card with a line-2 border above the composer, with one
// action as a secondary button. Radix announces it politely, keeps it while it is hovered or
// focused, and lets F8 move focus to it. A refusal uses a lantern border and a failure rose.

function ToastProvider({ duration = 8000, ...props }: React.ComponentProps<typeof ToastPrimitive.Provider>) {
  return <ToastPrimitive.Provider data-slot="toast-provider" duration={duration} swipeDirection="down" {...props} />;
}

function ToastViewport({ className, ...props }: React.ComponentProps<typeof ToastPrimitive.Viewport>) {
  return (
    <ToastPrimitive.Viewport
      data-slot="toast-viewport"
      className={cn("m-0 flex list-none flex-col gap-2 p-0 outline-none empty:hidden", className)}
      {...props}
    />
  );
}

const toastVariants = cva(
  "cut flex animate-hb-in items-center gap-3 border-2 border-solid bg-card px-4 py-2.5 text-sm text-text",
  {
    variants: {
      tone: {
        default: "border-line-2",
        refusal: "border-lantern",
        failure: "border-rose",
      },
    },
    defaultVariants: { tone: "default" },
  },
);

function Toast({
  className,
  tone,
  type = "background",
  ...props
}: React.ComponentProps<typeof ToastPrimitive.Root> & VariantProps<typeof toastVariants>) {
  return (
    <ToastPrimitive.Root data-slot="toast" type={type} className={cn(toastVariants({ tone, className }))} {...props} />
  );
}

function ToastDescription({ className, ...props }: React.ComponentProps<typeof ToastPrimitive.Description>) {
  return <ToastPrimitive.Description data-slot="toast-description" className={cn("flex-1", className)} {...props} />;
}

/** The toast's one action; choosing it closes the toast. */
function ToastAction({ className, ...props }: React.ComponentProps<typeof ToastPrimitive.Action>) {
  return (
    <ToastPrimitive.Action
      data-slot="toast-action"
      className={cn(
        "cut inline-flex cursor-pointer items-center border-2 border-solid border-control bg-transparent px-2 py-1 text-[13px] whitespace-nowrap text-text outline-none hover:bg-line",
        className,
      )}
      {...props}
    />
  );
}

export { Toast, ToastAction, ToastDescription, ToastProvider, ToastViewport };
