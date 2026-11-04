import { useNavigate } from "@tanstack/react-router";
import { type RefObject, useEffect, useEffectEvent } from "react";
import type { InboxEntry } from "./inbox-entries.ts";
import { stepFrom, stepKey } from "./inbox-keys.ts";

/**
 * ↑ and ↓, or K and J, move the selection through Needs you in the order the list shows, from
 * anywhere on the page. The new entry goes into the address in place, so Back leaves the Inbox
 * rather than stepping back through it. While focus is on a row it moves with the selection, so
 * the list stays one stop for Tab.
 */
export const useListKeys = (
  order: ReadonlyArray<InboxEntry>,
  selectedKey: string | undefined,
  list: RefObject<HTMLElement | null>,
) => {
  const navigate = useNavigate();
  const onKey = useEffectEvent((event: KeyboardEvent) => {
    const step = stepKey(event);
    const next = step === undefined ? undefined : stepFrom(order, selectedKey, step);
    if (next === undefined) return;
    event.preventDefault();
    const rows = list.current;
    if (rows?.contains(document.activeElement)) {
      rows.querySelector<HTMLElement>(`[data-entry="${CSS.escape(next.key)}"]`)?.focus();
    }
    if (next.key !== selectedKey) {
      void navigate({ to: "/inbox", search: { tab: "needs", request: next.key }, replace: true });
    }
  });
  useEffect(() => {
    const listener = (event: KeyboardEvent) => onKey(event);
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, []);
};
