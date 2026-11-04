import { Dialog as SheetPrimitive } from "radix-ui";
import type * as React from "react";
import { useRestoreFocus } from "../lib/restore-focus.ts";
import { cn } from "../lib/utils.ts";

// The work sheet (docs/design/ui-ux.md): a panel at the right edge of the window, over the chat,
// for the quest and the task inside it. Built on the shadcn Sheet, so it is a Radix dialog: focus
// stays inside while it is open, Escape or a click outside closes it, and focus goes back to what had
// it before, even when the app opened the sheet with no trigger. It slides in 24px and fades, and
// leaves the same way; Reduce motion stops both. Its corners, border, shadow and easing come from the
// theme's skin: soft and eased in Lamplight, cut corners and four steps in Workshop.

function Sheet(props: React.ComponentProps<typeof SheetPrimitive.Root>) {
  return <SheetPrimitive.Root data-slot="sheet" {...props} />;
}

function SheetTrigger(props: React.ComponentProps<typeof SheetPrimitive.Trigger>) {
  return <SheetPrimitive.Trigger data-slot="sheet-trigger" {...props} />;
}

function SheetClose(props: React.ComponentProps<typeof SheetPrimitive.Close>) {
  return <SheetPrimitive.Close data-slot="sheet-close" {...props} />;
}

function SheetContent({
  className,
  children,
  onCloseAutoFocus,
  container,
  ...props
}: React.ComponentProps<typeof SheetPrimitive.Content> & {
  /** Where the sheet mounts, such as the chat's column; it covers the whole window when left out. */
  container?: HTMLElement | null | undefined;
}) {
  const closeAutoFocus = useRestoreFocus(onCloseAutoFocus);
  return (
    <SheetPrimitive.Portal container={container}>
      {/* No dimming: the chat stays readable beside the sheet. The overlay only catches the click that closes it. */}
      <SheetPrimitive.Overlay data-slot="sheet-overlay" className="fixed inset-0 z-50" />
      <SheetPrimitive.Content
        data-slot="sheet-content"
        className={cn(
          "fixed inset-y-3 end-3 z-50 flex w-[calc(100vw-24px)] max-w-[340px] flex-col gap-3.5 overflow-y-auto *:shrink-0 cut border-(length:--edge) border-line bg-panel p-[18px] text-text-strong shadow-sheet outline-none",
          "duration-[220ms] ease-(--ease-ui) data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:slide-out-to-end-6 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:slide-in-from-end-6",
          className,
        )}
        {...props}
        onCloseAutoFocus={closeAutoFocus}
      >
        {children}
      </SheetPrimitive.Content>
    </SheetPrimitive.Portal>
  );
}

/** The sheet's top row: the eyebrow or back link, any actions, and the close button at the end. */
function SheetHeader({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="sheet-header" className={cn("flex items-center gap-2", className)} {...props} />;
}

function SheetTitle({ className, ...props }: React.ComponentProps<typeof SheetPrimitive.Title>) {
  return (
    <SheetPrimitive.Title
      data-slot="sheet-title"
      className={cn(
        "m-0 font-(family-name:--font-heading) text-2xl leading-[30px] font-(--heading-weight) text-text-strong in-[[data-theme^=workshop-]]:text-moonlight",
        className,
      )}
      {...props}
    />
  );
}

function SheetDescription({ className, ...props }: React.ComponentProps<typeof SheetPrimitive.Description>) {
  return (
    <SheetPrimitive.Description
      data-slot="sheet-description"
      className={cn("m-0 text-detail text-text-secondary", className)}
      {...props}
    />
  );
}

/** Actions at the bottom of the sheet, such as Cancel quest, pushed down when the content is short. */
function SheetFooter({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="sheet-footer" className={cn("mt-auto flex flex-col gap-2", className)} {...props} />;
}

/** The ✕ that closes the sheet. The consumer names it, so the label comes from its messages. */
function SheetCloseButton({
  className,
  label,
  ...props
}: Omit<React.ComponentProps<typeof SheetPrimitive.Close>, "children"> & { label: string }) {
  return (
    <SheetPrimitive.Close
      data-slot="sheet-close"
      aria-label={label}
      className={cn(
        "ms-auto inline-flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-control border-0 bg-transparent p-0 text-text-secondary hover:bg-hover hover:text-text-strong",
        className,
      )}
      {...props}
    >
      <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
        <path d="M1 1l10 10M11 1L1 11" />
      </svg>
    </SheetPrimitive.Close>
  );
}

export {
  Sheet,
  SheetClose,
  SheetCloseButton,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
};
