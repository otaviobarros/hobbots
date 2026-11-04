import { cn } from "@hobbots/ui/lib/utils";

/** The card that holds the Changes and Files lists beside the file they show. */
export const LIST_CARD = "flex shrink-0 flex-col gap-0.5 rounded-card border border-line bg-card p-1.5";

/** A row in those lists: on a line fill while its file is the one shown (STD-UI-006). */
export const listRow = (on: boolean): string =>
  cn(
    "flex w-full cursor-pointer gap-2 rounded-control border-0 px-2 py-[7px] text-start text-text transition-colors duration-(--dur-fade)",
    on ? "bg-line" : "bg-transparent hover:bg-hover",
  );
