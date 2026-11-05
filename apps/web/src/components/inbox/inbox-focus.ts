import type { RefObject } from "react";
import { type FocusTargets, firstControl } from "../move-on/follow-focus.ts";

/**
 * Where focus goes once the entry `key`, decided in its detail, leaves Needs you (#988): the row of
 * the entry that takes its place beside the list, or once nothing waits, the all-clear's first way on.
 */
export const inboxTargets =
  (list: RefObject<HTMLElement | null>, clear: RefObject<HTMLElement | null>, key: string): FocusTargets =>
  () => ({
    next: () =>
      list.current?.querySelector<HTMLElement>(
        `[data-entry][aria-current="page"]:not([data-entry="${CSS.escape(key)}"])`,
      ) ?? null,
    fallback: () => firstControl(clear.current),
  });
