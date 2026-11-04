import type { AttemptActivity, TaskFile } from "@hobbots/domain";
import { Button, buttonVariants } from "@hobbots/ui/components/button";
import { useState } from "react";
import { taskFileUrl } from "../../../api/workbench.ts";
import { canDownload } from "./files-model.ts";
import { messages } from "./messages.ts";

/**
 * Show in Finder in the desktop app, which runs on the hub; Download through the hub in a browser
 * or on another device. A file no longer there offers neither.
 */
export function FileActions({
  attemptId,
  file,
  name,
}: {
  attemptId: AttemptActivity["attempt"]["id"];
  file: TaskFile;
  name: string;
}) {
  const showFile = window.hobbots?.showFile;
  const [missed, setMissed] = useState(false);
  if (file.now === "gone") return null;
  if (showFile !== undefined) {
    return (
      <span className="flex items-center gap-2">
        {missed && <span className="text-meta text-lantern">{messages.notShown}</span>}
        <Button
          variant="chip"
          size="xs"
          aria-label={messages.showInFinderFor({ name })}
          onClick={() => void showFile(attemptId, file.id).then((shown) => setMissed(!shown))}
        >
          {messages.showInFinder}
        </Button>
      </span>
    );
  }
  if (!canDownload(file)) return null;
  return (
    <a
      href={taskFileUrl(attemptId, file.id, { download: true, version: file.hash })}
      download={name}
      aria-label={messages.downloadFor({ name })}
      className={buttonVariants({ variant: "chip", size: "xs", className: "no-underline" })}
    >
      {messages.download}
    </a>
  );
}
