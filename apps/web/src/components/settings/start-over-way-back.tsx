import type { BackupState } from "@hobbots/api";
import { Button } from "@hobbots/ui/components/button";
import { useQuery } from "@tanstack/react-query";
import { backupQuery, backupRunning, useStartBackup } from "../../api/backup.ts";
import { useBackupFolder, useChosenBackupFolder } from "../../api/backup-folder.ts";
import { ApiError } from "../../api/client.ts";
import { formatAgo } from "../../lib/format.ts";
import { messages } from "./messages.ts";

const copy = messages.startOver;

/** The words of a refusal: the hub's reason when it gave one. */
export const reasonOf = (error: Error | null) =>
  error instanceof ApiError && typeof error.fields.reason === "string" ? error.fields.reason : (error?.message ?? "");

/** When the last backup finished, or null when none has. */
export const lastBackupAt = (state: BackupState | undefined) => (state?._tag === "Done" ? state.finishedAt : null);

/** Back up first, to the folder chosen under Backups or else the hub's default, without leaving the dialog. */
export function WayBack() {
  const backup = useQuery(backupQuery);
  const start = useStartBackup();
  const state = backup.data?.state;
  const destination = useBackupFolder(backup.data?.defaultDestination);
  const chosen = useChosenBackupFolder() !== null;
  const running = backupRunning(state) || start.isPending;
  const last = lastBackupAt(state);
  const saved = last !== null && start.isSuccess;
  const line = backupLine(state, running, { destination, chosen }, start.isError ? reasonOf(start.error) : null);
  return (
    <div className="flex flex-wrap items-center gap-2.5 rounded-control bg-card px-3 py-2.5">
      <span className="flex min-w-0 flex-1 flex-col">
        <strong className="text-ui text-text-strong">{copy.wayBack}</strong>
        <span role="status" className="text-detail text-text-secondary">
          {line}
        </span>
      </span>
      <Button
        variant="outline"
        size="sm"
        disabled={running || saved || destination === "" || backup.data === undefined}
        onClick={() => start.mutate(destination)}
      >
        {saved ? copy.backedUp : running ? copy.backupRunning : copy.backUp}
      </Button>
    </div>
  );
}

/**
 * The line beside Back up first: why it waits, how the backup goes, or when the last one finished.
 * It names the folder the backup goes to, and says it was chosen under Backups only when it was.
 */
const backupLine = (
  state: BackupState | undefined,
  running: boolean,
  { destination, chosen }: { destination: string; chosen: boolean },
  refused: string | null,
) => {
  if (refused !== null) return copy.backupFailed({ reason: refused });
  if (running) return copy.backupRunning;
  if (state?._tag === "Failed") return copy.backupFailed({ reason: state.reason });
  if (state?._tag === "Done") return copy.backupDone({ when: formatAgo(state.finishedAt), path: state.path });
  if (destination === "") return copy.backupNoFolder;
  return chosen ? copy.backupNone({ folder: destination }) : copy.backupDefault({ folder: destination });
};
