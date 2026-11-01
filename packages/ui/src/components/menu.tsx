import { cn } from "cn";
import { ContextMenu as ContextMenuPrimitive, DropdownMenu as DropdownMenuPrimitive } from "radix-ui";
import type * as React from "react";

// Hobbots menus (docs/design/ui-ux.md): a card with pixel corners and the line-2 border, opened from
// a ⋯ button (DropdownMenu) or by right-click, Shift+F10 or the context-menu key (ContextMenu).
// Radix moves focus into the menu, moves it with the arrow keys, closes it on Escape and returns
// focus to where it was. A disabled item stays in the menu with its reason and cannot be chosen.

const contentClass =
  "cut z-50 flex min-w-[220px] max-w-[300px] flex-col border-2 border-solid border-line-2 bg-card p-1 text-text outline-none";

const itemClass =
  "flex cursor-pointer flex-col gap-0.5 px-2.5 py-2 text-sm outline-none select-none data-highlighted:bg-hover data-disabled:cursor-default data-disabled:text-label";

function DropdownMenu(props: React.ComponentProps<typeof DropdownMenuPrimitive.Root>) {
  return <DropdownMenuPrimitive.Root data-slot="dropdown-menu" {...props} />;
}

function DropdownMenuTrigger(props: React.ComponentProps<typeof DropdownMenuPrimitive.Trigger>) {
  return <DropdownMenuPrimitive.Trigger data-slot="dropdown-menu-trigger" {...props} />;
}

function DropdownMenuContent({
  className,
  align = "start",
  sideOffset = 4,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Content>) {
  return (
    <DropdownMenuPrimitive.Portal>
      <DropdownMenuPrimitive.Content
        data-slot="dropdown-menu-content"
        align={align}
        sideOffset={sideOffset}
        collisionPadding={8}
        className={cn(contentClass, className)}
        {...props}
      />
    </DropdownMenuPrimitive.Portal>
  );
}

function DropdownMenuItem({ className, ...props }: React.ComponentProps<typeof DropdownMenuPrimitive.Item>) {
  return <DropdownMenuPrimitive.Item data-slot="dropdown-menu-item" className={cn(itemClass, className)} {...props} />;
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
  return <kbd data-slot="menu-shortcut" className={cn("ms-auto font-sans text-xs text-label", className)} {...props} />;
}

export {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  MenuShortcut,
};
