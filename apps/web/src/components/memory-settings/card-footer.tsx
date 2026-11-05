import { Button } from "@hobbots/ui/components/button";
import { useShowMemoryFiles } from "../../lib/show-memory-files.ts";
import { messages } from "./messages.ts";

const copy = messages;

/**
 * Show the files, on the desktop app on the hub, and which engine keeps memory. Opening the folder
 * says when it could not, as when no hob has saved anything yet, and can be tried again.
 */
export function CardFooter({ version }: { version: string | null }) {
  const files = useShowMemoryFiles();
  const { open, state } = files;
  return (
    <>
      {open !== undefined && (
        <div className="flex flex-col gap-2 border-t border-line pt-3">
          <span className="flex flex-wrap gap-2">
            <Button
              variant="ghost"
              size="sm"
              disabled={state === "pending"}
              aria-busy={state === "pending"}
              onClick={() => void open()}
            >
              {state === "pending" ? copy.card.opening : state === "failed" ? copy.card.tryAgain : copy.card.showFiles}
            </Button>
          </span>
          {state === "failed" && (
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
