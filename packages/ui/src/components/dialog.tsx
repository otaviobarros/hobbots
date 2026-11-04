import { cn } from "cn";
import { Dialog as DialogPrimitive } from "radix-ui";
import type * as React from "react";
import { useState } from "react";

// A Hobbots modal: a panel with pixel corners over a dimmed page. Radix keeps focus inside while it
// is open and hides the page behind it from assistive technology. When it closes, focus goes back to
// what had it before it opened, so a dialog the app opens by itself, with no trigger, works too.
function Dialog(props: React.ComponentProps<typeof DialogPrimitive.Root>) {
  return <DialogPrimitive.Root data-slot="dialog" {...props} />;
}

/** Where focus goes back to: what had it when the dialog opened, or the page's main landmark if that is gone. */
const restoreFocus = (before: HTMLElement | null) => {
  if (before?.isConnected) {
    before.focus();
    return;
  }
  const main = document.querySelector<HTMLElement>("main");
  if (main === null) return;
  if (!main.hasAttribute("tabindex")) main.setAttribute("tabindex", "-1");
  main.focus();
};

function DialogContent({
  className,
  children,
  onCloseAutoFocus,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content>) {
  // Read while rendering, before Radix moves focus into the dialog.
  const [before] = useState(() =>
    document.activeElement instanceof HTMLElement && document.activeElement !== document.body
      ? document.activeElement
      : null,
  );
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
        onCloseAutoFocus={(event) => {
          onCloseAutoFocus?.(event);
          if (event.defaultPrevented) return;
          // Radix would focus its trigger, and a dialog the app opened by itself has none.
          event.preventDefault();
          restoreFocus(before);
        }}
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

export { Dialog, DialogContent, DialogDescription, DialogTitle };
