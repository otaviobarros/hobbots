import { cva, type VariantProps } from "class-variance-authority";
import { ContextMenu as ContextMenuPrimitive, DropdownMenu as DropdownMenuPrimitive } from "radix-ui";
import type * as React from "react";
import { cn } from "../lib/utils.ts";

// Hobbots menus (docs/design/ui-ux.md): a card with pixel corners and the line-2 border, opened from
// a ⋯ button (DropdownMenu) or by right-click, Shift+F10 or the context-menu key (ContextMenu).
// Radix moves focus into the menu, moves it with the arrow keys, closes it on Escape and returns
// focus to where it was. The highlighted item keeps the hover fill and adds an inset focus-ring
// outline, so keyboard focus shows and Workshop's cut corners don't clip it. A disabled item stays in the menu with its reason and cannot be chosen.

const contentClass =
  "cut z-50 flex min-w-[220px] max-w-[300px] flex-col border-(length:--edge) border-solid border-line-2 bg-card p-1 text-text-strong outline-none";

const itemClass =
  "flex cursor-pointer flex-col gap-0.5 px-2.5 py-2 text-ui outline-none select-none data-highlighted:bg-hover data-highlighted:outline-2 data-highlighted:outline-solid data-highlighted:-outline-offset-2 data-highlighted:outline-focus-ring data-disabled:cursor-default data-disabled:text-label";

function DropdownMenu(props: React.ComponentProps<typeof DropdownMenuPrimitive.Root>) {
  return <DropdownMenuPrimitive.Root data-slot="dropdown-menu" {...props} />;
}

function DropdownMenuTrigger(props: React.ComponentProps<typeof DropdownMenuPrimitive.Trigger>) {
  return <DropdownMenuPrimitive.Trigger data-slot="dropdown-menu-trigger" {...props} />;
}

/**
 * A trigger that looks like a field naming the current choice, with ▾ after it, as a select does
 * (Hobbots never shows the system's own select menu).
 */
function DropdownMenuSelectTrigger({
  className,
  children,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Trigger>) {
  return (
    <DropdownMenuPrimitive.Trigger
      data-slot="dropdown-menu-select-trigger"
      className={cn(
        "flex h-8 max-w-full min-w-0 cursor-pointer items-center gap-2 rounded-control border-(length:--edge) border-control bg-deep px-2.5 text-start text-detail text-text-strong hover:border-lantern disabled:cursor-default disabled:opacity-60 data-[state=open]:border-lantern",
        className,
      )}
      {...props}
    >
      <span className="min-w-0 truncate">{children}</span>
      <span aria-hidden className="shrink-0 text-meta text-label">
        ▾
      </span>
    </DropdownMenuPrimitive.Trigger>
  );
}

// `list` is a long list to pick from, such as a select's: rounded, shadowed, and scrolling past 360px.
const dropdownContentVariants = cva(contentClass, {
  variants: {
    look: {
      menu: "",
      list: "max-h-[360px] overflow-y-auto rounded-card border border-line-2 shadow-menu [clip-path:none]",
    },
  },
  defaultVariants: { look: "menu" },
});

function DropdownMenuContent({
  className,
  align = "start",
  sideOffset = 4,
  look = "menu",
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Content> & VariantProps<typeof dropdownContentVariants>) {
  return (
    <DropdownMenuPrimitive.Portal>
      <DropdownMenuPrimitive.Content
        data-slot="dropdown-menu-content"
        align={align}
        sideOffset={sideOffset}
        collisionPadding={8}
        className={cn(dropdownContentVariants({ look }), className)}
        {...props}
      />
    </DropdownMenuPrimitive.Portal>
  );
}

// `deny` marks the item that takes something away, such as Cancel quest…, in rose.
// `inset` indents an item under a label, such as each hob a Reassign… view lists, with what leads it on one line.
const dropdownItemVariants = cva(itemClass, {
  variants: {
    variant: { default: "", deny: "text-rose" },
    inset: { true: "flex-row items-center gap-2 ps-5", false: "" },
  },
  defaultVariants: { variant: "default", inset: false },
});

function DropdownMenuItem({
  className,
  variant = "default",
  inset = false,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Item> & VariantProps<typeof dropdownItemVariants>) {
  return (
    <DropdownMenuPrimitive.Item
      data-slot="dropdown-menu-item"
      className={cn(dropdownItemVariants({ variant, inset }), className)}
      {...props}
    />
  );
}

/** A set of items where one is chosen, such as a list of models; the chosen one shows a check. */
function DropdownMenuRadioGroup(props: React.ComponentProps<typeof DropdownMenuPrimitive.RadioGroup>) {
  return <DropdownMenuPrimitive.RadioGroup data-slot="dropdown-menu-radio-group" {...props} />;
}

function DropdownMenuRadioItem({
  className,
  children,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.RadioItem>) {
  return (
    <DropdownMenuPrimitive.RadioItem
      data-slot="dropdown-menu-radio-item"
      className={cn(itemClass, "flex-row items-center gap-2 ps-7 relative", className)}
      {...props}
    >
      <DropdownMenuPrimitive.ItemIndicator className="absolute start-2.5 text-moonlight" aria-hidden>
        ✓
      </DropdownMenuPrimitive.ItemIndicator>
      {children}
    </DropdownMenuPrimitive.RadioItem>
  );
}

/** A hairline between groups of items, such as before the one that takes something away. */
function DropdownMenuSeparator({ className, ...props }: React.ComponentProps<typeof DropdownMenuPrimitive.Separator>) {
  return (
    <DropdownMenuPrimitive.Separator
      data-slot="dropdown-menu-separator"
      className={cn("mx-0.5 my-1 h-px bg-line", className)}
      {...props}
    />
  );
}

/** A line of text in a menu that is not an item, such as what an item below it does. */
function DropdownMenuLabel({ className, ...props }: React.ComponentProps<typeof DropdownMenuPrimitive.Label>) {
  return (
    <DropdownMenuPrimitive.Label
      data-slot="dropdown-menu-label"
      className={cn("px-2.5 pt-0.5 pb-1.5 text-meta text-label", className)}
      {...props}
    />
  );
}

function ContextMenu(props: React.ComponentProps<typeof ContextMenuPrimitive.Root>) {
  return <ContextMenuPrimitive.Root data-slot="context-menu" {...props} />;
}

function ContextMenuTrigger(props: React.ComponentProps<typeof ContextMenuPrimitive.Trigger>) {
  return <ContextMenuPrimitive.Trigger data-slot="context-menu-trigger" {...props} />;
}

function ContextMenuContent({ className, ...props }: React.ComponentProps<typeof ContextMenuPrimitive.Content>) {
  return (
    <ContextMenuPrimitive.Portal>
      <ContextMenuPrimitive.Content
        data-slot="context-menu-content"
        collisionPadding={8}
        className={cn(contentClass, className)}
        {...props}
      />
    </ContextMenuPrimitive.Portal>
  );
}

function ContextMenuItem({ className, ...props }: React.ComponentProps<typeof ContextMenuPrimitive.Item>) {
  return <ContextMenuPrimitive.Item data-slot="context-menu-item" className={cn(itemClass, className)} {...props} />;
}

/** An item's shortcut, shown at the end of its first line. */
function MenuShortcut({ className, ...props }: React.ComponentProps<"kbd">) {
  return (
    <kbd data-slot="menu-shortcut" className={cn("ms-auto font-sans text-meta text-label", className)} {...props} />
  );
}

export {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSelectTrigger,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  MenuShortcut,
};
