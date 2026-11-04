import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@hobbots/ui/components/menu";
import { cn } from "@hobbots/ui/lib/utils";
import type { ReactNode } from "react";
import { messages } from "./messages.ts";

/**
 * The file list folded into one line, for a tab narrower than 720px: previous, the file shown with
 * its tag and "3 of 6", and next. The name opens the whole list as a menu. Its parent shows it only
 * at that width, through the tab panel's container query. Narrower than 300px the count gives its
 * room to the name.
 */
export function FilePicker<Item>({
  label,
  items,
  shown,
  current,
  row,
  onPick,
}: {
  /** The list's name, such as "Changed files". */
  label: string;
  items: ReadonlyArray<Item>;
  /** The index of the file shown. */
  shown: number;
  /** The file shown, as the line names it. */
  current: ReactNode;
  /** One file's row in the menu. */
  row: (item: Item) => ReactNode;
  onPick: (index: number) => void;
}) {
  const step = (by: number) => onPick((shown + by + items.length) % items.length);
  return (
    <div className="@container/picker flex items-center gap-1.5 @min-[720px]:hidden">
      <Step label={messages.picker.previous} onClick={() => step(-1)}>
        ‹
      </Step>
      <DropdownMenu>
        <DropdownMenuTrigger
          aria-label={messages.picker.open({ label })}
          className="flex h-[34px] min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-control border border-line-2 bg-card px-3 text-start text-text hover:border-lantern data-[state=open]:border-lantern"
        >
          <span className="flex min-w-0 flex-1 items-center gap-2">{current}</span>
          <span className="hidden shrink-0 text-meta whitespace-nowrap text-label @min-[300px]/picker:inline">
            {messages.picker.of({ index: shown + 1, total: items.length })}
          </span>
          <span aria-hidden className="shrink-0 text-meta text-label">
            ▾
          </span>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          aria-label={label}
          className="max-h-[360px] w-(--radix-dropdown-menu-trigger-width) max-w-none overflow-y-auto rounded-card border border-line-2 shadow-menu [clip-path:none]"
        >
          {items.map((item, index) => (
            <DropdownMenuItem
              // The list keeps its order while the menu is open, so a place names its item.
              // biome-ignore lint/suspicious/noArrayIndexKey: the menu lists the items in their order
              key={index}
              aria-current={index === shown ? "true" : undefined}
              onSelect={() => onPick(index)}
              className={cn("rounded-control", index === shown && "bg-line")}
            >
              {row(item)}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      <Step label={messages.picker.next} onClick={() => step(1)}>
        ›
      </Step>
    </div>
  );
}

function Step({ label, onClick, children }: { label: string; onClick: () => void; children: string }) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className="h-[34px] w-8 shrink-0 cursor-pointer rounded-control border border-line-2 bg-card text-lg leading-none text-text-secondary hover:border-lantern hover:text-text-strong"
    >
      <span aria-hidden>{children}</span>
    </button>
  );
}
