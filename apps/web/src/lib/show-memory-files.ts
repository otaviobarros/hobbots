import { useState } from "react";

/**
 * Show the files: on the desktop app on the hub, opens the folder that holds memory's pages as
 * markdown in Finder (ADR 028). `open` is absent anywhere else. Opening says when it could not, as
 * when no hob has saved anything yet, and can be tried again; it answers whether the folder opened.
 */
export const useShowMemoryFiles = () => {
  const show = window.hobbots?.showMemoryFiles;
  const [state, setState] = useState<"idle" | "pending" | "failed">("idle");
  const open =
    show === undefined
      ? undefined
      : async () => {
          setState("pending");
          const shown = await show().catch(() => false);
          setState(shown ? "idle" : "failed");
          return shown;
        };
  return { open, state };
};
