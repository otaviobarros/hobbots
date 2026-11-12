import { Skeleton } from "@hobbots/ui/components/skeleton";
import type { ReactNode } from "react";
import { ReadFailed } from "../web/read-failed.tsx";
import { messages } from "./messages.ts";

/** What a tab's read shows besides its rows (STD-REACT-015): loading, failed with Read again, or empty. */
export function ReadState({
  read,
  empty,
}: {
  read: { readonly isPending: boolean; readonly isError: boolean; readonly refetch: () => unknown };
  /** What the tab says once read with nothing to show, or undefined when it has rows. */
  empty: string | undefined;
}) {
  if (read.isError) return <ReadFailed text={messages.readFailed} onRetry={() => void read.refetch()} />;
  if (read.isPending) {
    return (
      <p aria-busy className="m-0 flex flex-col gap-1.5">
        <Skeleton width="24ch" />
        <Skeleton width="16ch" />
      </p>
    );
  }
  return empty === undefined ? null : <p className="m-0 text-ui text-label">{empty}</p>;
}

/** A labelled part of a tab, such as Quests or Pinned. */
export function SheetSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section aria-label={title} className="flex flex-col gap-1.5">
      <h3 className="lbl m-0 text-meta font-normal text-label">{title}</h3>
      {children}
    </section>
  );
}
