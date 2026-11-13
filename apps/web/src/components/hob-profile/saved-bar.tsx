import type { HobPermissions } from "@hobbots/api";
import { reachLines } from "./change-reach-model.ts";

// The save bar is the inverted surface, like the toasts: light in the dark themes and dark in the
// light ones. The theme's focus ring is chosen to show on ground, so here focus is a ground ring
// drawn inside the button in every theme.

/** The bar that floats at the bottom of a hob's page while a change is unsaved, or once it is saved. */
export const BAR =
  "cut sticky bottom-4 z-10 flex animate-hb-in items-center gap-3 bg-text-strong px-4 py-3 text-ground shadow-menu [--control-focus-outline:none] [--control-focus-ring:inset_0_0_0_2px_var(--color-ground)]";
// Undo and Save changes: text buttons on the inverted bar.
export const BAR_ACTION =
  "cut-control cursor-pointer border-0 bg-transparent px-2 py-1 font-bold whitespace-nowrap text-ground underline underline-offset-2 hover:no-underline disabled:cursor-default disabled:no-underline disabled:opacity-50";

/**
 * The bar once a change is saved: a check mark, when the change applies, and each tool some of the
 * hob's sessions still do not get, with why (#1347).
 */
export function SavedBar({ text, lines }: { text: string; lines: ReadonlyArray<string> }) {
  return (
    <div role="status" className={BAR}>
      <span aria-hidden className="font-bold">
        ✓
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="text-ui">{text}</span>
        {lines.map((line) => (
          <span key={line} className="text-detail">
            {line}
          </span>
        ))}
      </span>
    </div>
  );
}

/**
 * At the foot of a Charm's card, after its last save: each tool that save opened that some of the
 * hob's sessions still do not get (#1347), or, when it failed, that it failed.
 */
export function CardSaveOutcome({
  hob,
  save,
  failed,
}: {
  hob: { readonly name: string };
  save: { readonly isError: boolean; readonly data: HobPermissions | undefined };
  failed: string;
}) {
  if (save.isError) {
    return (
      <span role="alert" className="ps-16 pe-4.5 pb-4 text-detail text-rose">
        {failed}
      </span>
    );
  }
  const lines = reachLines(hob, save.data?.reach);
  if (lines.length === 0) return null;
  return (
    <div role="status" className="flex flex-col gap-1 ps-16 pe-4.5 pb-4 text-detail text-text-secondary">
      {lines.map((line) => (
        <span key={line}>{line}</span>
      ))}
    </div>
  );
}
