import { cn } from "cn";
import { Dialog as DialogPrimitive } from "radix-ui";
import type * as React from "react";
import { useRestoreFocus } from "../lib/restore-focus.ts";

// A Hobbots modal: a panel with pixel corners over a dimmed page. Radix keeps focus inside while it
// is open and hides the page behind it from assistive technology. When it closes, focus goes back to
// what had it before it opened, so a dialog the app opens by itself, with no trigger, works too.
function Dialog(props: React.ComponentProps<typeof DialogPrimitive.Root>) {
  return <DialogPrimitive.Root data-slot="dialog" {...props} />;
}

function DialogContent({
  className,
  children,
  onCloseAutoFocus,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content>) {
  const closeAutoFocus = useRestoreFocus(onCloseAutoFocus);
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay data-slot="dialog-overlay" className="fixed inset-0 z-50 bg-deep/70" />
      <DialogPrimitive.Content
        data-slot="dialog-content"
        className={cn(
          "cut fixed top-1/2 left-1/2 z-50 flex w-[calc(100vw-32px)] max-w-[560px] -translate-x-1/2 -translate-y-1/2 flex-col gap-3.5 border-2 border-control bg-panel px-7 py-6 text-text-strong outline-none",
          className,
        )}
        {...props}
        onCloseAutoFocus={closeAutoFocus}
      >
        {children}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

function DialogTitle(props: React.ComponentProps<typeof DialogPrimitive.Title>) {
  return <DialogPrimitive.Title data-slot="dialog-title" {...props} />;
}

function DialogDescription(props: React.ComponentProps<typeof DialogPrimitive.Description>) {
  return <DialogPrimitive.Description data-slot="dialog-description" {...props} />;
}

function DialogClose(props: React.ComponentProps<typeof DialogPrimitive.Close>) {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />;
}

export { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle };
