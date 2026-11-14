import { Empty, EmptyDescription } from "@hobbots/ui/components/empty";
import { Skeleton } from "@hobbots/ui/components/skeleton";

/** The rows that hold a section's place while it loads, by the likely length of each name. */
const LOADING_ROWS = ["12ch", "10ch", "8ch"] as const;

/**
 * A section still loading (STD-REACT-015): still rows with a tile and a line where its rows will be,
 * named for assistive technology by the list's label and its busy state. The rail shows only tiles.
 */
export function SidebarLoading({ label }: { label: string }) {
  return (
    <ul aria-label={label} aria-busy className="m-0 flex w-full list-none flex-col items-center gap-0.5 p-0">
      {LOADING_ROWS.map((width) => (
        <li
          key={width}
          className="flex min-h-[34px] w-full items-center gap-2.5 px-2 max-wide:h-11 max-wide:w-12 max-wide:justify-center max-wide:p-0"
        >
          <Skeleton shape="tile" className="size-hob-tile max-wide:size-7.5" />
          <Skeleton width={width} className="text-ui max-wide:hidden" />
        </li>
      ))}
    </ul>
  );
}

/** A section with nothing in it yet: one line saying so. The rail reads it out without showing it. */
export function SidebarEmpty({ message }: { message: string }) {
  return (
    <Empty className="gap-0 px-2.5 py-2 max-wide:sr-only">
      <EmptyDescription className="text-detail">{message}</EmptyDescription>
    </Empty>
  );
}
