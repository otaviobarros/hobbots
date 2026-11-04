import type { RestoreSummary } from "@hobbots/api";
import { Button } from "@hobbots/ui/components/button";
import { useEffect, useRef, useState } from "react";
import { useInspectBackup, useRestoreBackup } from "../../api/backup.ts";
import { ApiError } from "../../api/client.ts";
import { formatMoment } from "../../lib/format.ts";
import { FolderField } from "./folder-field.tsx";
import { messages } from "./messages.ts";

const copy = messages.restore;

/** The words of a refusal: the hub's reason when it gave one. */
const reasonOf = (error: Error | null) =>
  error instanceof ApiError && typeof error.fields.reason === "string" ? error.fields.reason : error?.message;

function Summary({ summary }: { summary: RestoreSummary }) {
  return (
    <div className="flex flex-col gap-2 text-ui">
      <span className="lbl text-meta text-label">{copy.summaryTitle}</span>
      <span className="font-bold">
        {copy.made({ when: formatMoment(summary.createdAt), version: summary.hobbotsVersion })}
      </span>
      <span>{copy.counts(summary)}</span>
      {summary.missingFolders.length > 0 && (
        <div className="flex flex-col gap-1">
          <span className="text-lantern">{copy.missing}</span>
          <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
            {summary.missingFolders.map((folder) => (
              <li key={folder} className="font-mono text-code break-all text-text-secondary">
                {folder}
              </li>
            ))}
          </ul>
        </div>
      )}
      <span className="text-text-secondary">{copy.notBack}</span>
      <span className="text-text-secondary">{copy.replaces}</span>
    </div>
  );
}

/**
 * Restore from a backup (ADR 026): pick the backup folder, read what it holds before anything
 * changes, then confirm. The hub checks it again, stops, restores and starts on the restored data,
 * and the page loads again from it.
 */
export function RestoreFlow({ onCancel }: { onCancel?: () => void }) {
  const [path, setPath] = useState("");
  const inspect = useInspectBackup();
  const restore = useRestoreBackup();
  const confirmButton = useRef<HTMLButtonElement>(null);
  const summary = inspect.data;
  const busy = inspect.isPending || restore.isPending;

  useEffect(() => {
    if (summary) confirmButton.current?.focus();
  }, [summary]);

  if (restore.isPending) {
    return (
      <p role="status" className="m-0 text-ui text-mint">
        {copy.restoring}
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <FolderField
        label={copy.path}
        hint={copy.pathHint}
        chooseLabel={copy.choose}
        purpose="restore"
        value={path}
        disabled={busy}
        onChange={(next) => {
          setPath(next);
          inspect.reset();
        }}
      />
      {inspect.isError && (
        <p role="alert" className="m-0 text-ui text-rose">
          {reasonOf(inspect.error)}
        </p>
      )}
      {summary ? (
        <div className="cut flex flex-col gap-3 border-(length:--edge) border-lantern bg-deep px-4 py-3">
          <Summary summary={summary} />
          {restore.isError && (
            <p role="alert" className="m-0 text-ui text-rose">
              {copy.failed({ reason: reasonOf(restore.error) ?? "" })}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button ref={confirmButton} variant="deny" onClick={() => restore.mutate(summary.path)}>
              {copy.confirm}
            </Button>
            <Button variant="outline" onClick={() => (onCancel ? onCancel() : inspect.reset())}>
              {copy.cancel}
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          <Button disabled={busy || path.trim() === ""} onClick={() => inspect.mutate(path.trim())}>
            {inspect.isPending ? copy.reading : copy.read}
          </Button>
          {onCancel && (
            <Button variant="outline" onClick={onCancel}>
              {copy.cancel}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
