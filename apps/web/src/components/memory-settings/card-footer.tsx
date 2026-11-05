import { Button } from "@hobbots/ui/components/button";
import { useState } from "react";
import { messages } from "./messages.ts";

const copy = messages;

/**
 * Show the files, on the desktop app on the hub, and which engine keeps memory. Opening the folder
 * says when it could not, as when no hob has saved anything yet, and can be tried again.
 */
export function CardFooter({ version }: { version: string | null }) {
  const showFiles = window.hobbots?.showMemoryFiles;
  const [opening, setOpening] = useState<"idle" | "pending" | "failed">("idle");
  const open = async (show: () => Promise<boolean>) => {
    setOpening("pending");
    const shown = await show().catch(() => false);
    setOpening(shown ? "idle" : "failed");
  };
  return (
    <>
      {showFiles !== undefined && (
        <div className="flex flex-col gap-2 border-t border-line pt-3">
          <span className="flex flex-wrap gap-2">
            <Button
              variant="ghost"
              size="sm"
              disabled={opening === "pending"}
              aria-busy={opening === "pending"}
              onClick={() => void open(showFiles)}
            >
              {opening === "pending"
                ? copy.card.opening
                : opening === "failed"
                  ? copy.card.tryAgain
                  : copy.card.showFiles}
            </Button>
          </span>
          {opening === "failed" && (
            <p role="alert" className="m-0 text-ui text-rose">
              {copy.card.showFailed}
            </p>
          )}
        </div>
      )}
      {version !== null && <span className="text-meta text-label">{copy.card.engine({ version })}</span>}
    </>
  );
}
