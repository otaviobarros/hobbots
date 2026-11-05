import type { ReactNode } from "react";

/** A tray item's details, folded under one line until you open them. */
export function Details({ summary, children }: { summary: string; children: ReactNode }) {
  return (
    <details className="text-detail">
      <summary className="cursor-pointer text-label">{summary}</summary>
      <div className="mt-2 text-text-secondary">{children}</div>
    </details>
  );
}
