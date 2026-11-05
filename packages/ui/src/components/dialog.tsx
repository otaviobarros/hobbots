import { cva, type VariantProps } from "class-variance-authority";
import { Dialog as DialogPrimitive } from "radix-ui";
import type * as React from "react";
import { useRestoreFocus } from "../lib/restore-focus.ts";
import { cn } from "../lib/utils.ts";

// A Hobbots modal: a panel with pixel corners over a dimmed page. Radix keeps focus inside while it
// is open and hides the page behind it from assistive technology. When it closes, focus goes back to
// what had it before it opened, so a dialog the app opens by itself, with no trigger, works too.
function Dialog(props: React.ComponentProps<typeof DialogPrimitive.Root>) {
  return <DialogPrimitive.Root data-slot="dialog" {...props} />;
}

const dialogContentVariants = cva(
  // standards-allow STD-I18N-004: left-1/2 with -translate-x-1/2 centers the box, and translate has no logical form
  "fixed top-1/2 left-1/2 z-50 flex w-[calc(100vw-32px)] max-w-column-max -translate-x-1/2 -translate-y-1/2 flex-col gap-3.5 text-text-strong outline-none",
  {
    variants: {
      variant: {
        default: "cut border-(length:--edge) border-control bg-panel px-7 py-6",
        // A rounded sheet on the ground color that scrolls when it runs long, such as Start over.
        sheet: "animate-hb-in overflow-y-auto rounded-card bg-ground p-5 shadow-sheet",
      },
    },
    defaultVariants: { variant: "default" },
  },
);

const dialogTitleVariants = cva("", {
  variants: { variant: { plain: "", heading: "m-0 font-heading text-heading font-bold" } },
  defaultVariants: { variant: "plain" },
});

const dialogDescriptionVariants = cva("", {
  variants: {
    variant: { plain: "", lead: "m-0 text-ui text-text-secondary", alert: "m-0 text-ui text-rose" },
  },
  defaultVariants: { variant: "plain" },
});

function DialogContent({
  className,
  variant,
  children,
  onOpenAutoFocus,
  onCloseAutoFocus,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content> & VariantProps<typeof dialogContentVariants>) {
  const autoFocus = useRestoreFocus({ onOpenAutoFocus, onCloseAutoFocus });
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay data-slot="dialog-overlay" className="fixed inset-0 z-50 bg-deep/70" />
      <DialogPrimitive.Content
        data-slot="dialog-content"
        className={cn(dialogContentVariants({ variant }), className)}
        {...props}
        onOpenAutoFocus={autoFocus.onOpenAutoFocus}
        onCloseAutoFocus={autoFocus.onCloseAutoFocus}
      >
        {children}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

function DialogTitle({
  className,
  variant,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Title> & VariantProps<typeof dialogTitleVariants>) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={cn(dialogTitleVariants({ variant }), className) || undefined}
      {...props}
    />
  );
}

function DialogDescription({
  className,
  variant,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Description> & VariantProps<typeof dialogDescriptionVariants>) {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={cn(dialogDescriptionVariants({ variant }), className) || undefined}
      {...props}
    />
  );
}

function DialogClose(props: React.ComponentProps<typeof DialogPrimitive.Close>) {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />;
}

export { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle };
