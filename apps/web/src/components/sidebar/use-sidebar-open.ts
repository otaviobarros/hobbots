import { useEffect, useState } from "react";
import { readStored, writeStored } from "../../lib/storage.ts";

const openKey = "sidebar.open";

/** ⌘\ on a Mac, or Ctrl+\ elsewhere, with no other modifier. */
export const isSidebarKey = (event: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">) =>
  event.key === "\\" && (event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey;

/** The other state, saved so this device opens the sidebar the same way next time. */
const flip = (was: boolean) => {
  writeStored(openKey, !was);
  return !was;
};

/**
 * Whether the sidebar is expanded. It starts collapsed, and this device remembers the choice. The
 * chevron and ⌘\ both toggle it.
 */
export const useSidebarOpen = () => {
  const [open, setOpen] = useState(() => readStored(openKey, false));

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!isSidebarKey(event)) return;
      event.preventDefault();
      setOpen(flip);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return [open, () => setOpen(flip)] as const;
};
