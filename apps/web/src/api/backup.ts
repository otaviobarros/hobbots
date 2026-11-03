import type { BackupState, RestoreStatus } from "@hobbots/api";
import { queryOptions, useMutation, useQueryClient } from "@tanstack/react-query";
import { call } from "./client.ts";

/** Settings › Backup & export (ADR 026): Back up now, Restore, and what the latest restore left. */
const backupKey = ["backup"] as const;
const restoreKey = ["restore"] as const;

/** Whether a backup is under way, so Settings follows its progress. */
export const backupRunning = (state: BackupState | undefined) => state?._tag === "Waiting" || state?._tag === "Copying";

/** How often Settings asks for a running backup's progress. */
const BACKUP_POLL_MS = 500;

export const backupQuery = queryOptions({
  queryKey: backupKey,
  queryFn: () => call((c) => c.backup.status()),
  refetchInterval: (query) => (backupRunning(query.state.data?.state) ? BACKUP_POLL_MS : false),
});

export const useStartBackup = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (destination: string) => call((c) => c.backup.start({ payload: { destination } })),
    onSuccess: (status) => queryClient.setQueryData(backupKey, status),
  });
};

export const useCancelBackup = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => call((c) => c.backup.cancel()),
    onSuccess: (status) => queryClient.setQueryData(backupKey, status),
  });
};

export const restoreStatusQuery = queryOptions({
  queryKey: restoreKey,
  queryFn: () => call((c) => c.backup.restoreStatus()),
});

/** Whether work is held after a restore, for the notices on Home and the Quest tab. */
export const workHeld = (status: RestoreStatus | undefined) => status?.latest?.workHeld === true;

/** Reads a backup and what it holds, before anything changes. */
export const useInspectBackup = () =>
  useMutation({ mutationFn: (path: string) => call((c) => c.backup.inspect({ payload: { path } })) });

/** How long the page waits for the hub to start again after a restore, and how often it looks. */
const RESTART_WAIT = { timeoutMs: 120_000, everyMs: 1000 } as const;

type Health = { readonly installationId?: string } | object;

/** The installation a health answer names; only the hub's own computer learns it (ADR 021). */
const installationOf = (health: Health): string | null =>
  "installationId" in health && typeof health.installationId === "string" ? health.installationId : null;

/**
 * Resolves once the restored hub answers (ADR 026): one with an installation other than `before`,
 * since a restored hub always has a new one, or, where the installation is not shown, one that
 * answers again after it stopped. Rejects after the timeout.
 */
export const waitForRestoredHub = async (
  before: string | null,
  health: () => Promise<Health> = () => call((c) => c.health.health()),
  wait: { readonly timeoutMs: number; readonly everyMs: number } = RESTART_WAIT,
  sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
) => {
  const deadline = Date.now() + wait.timeoutMs;
  let stopped = false;
  while (Date.now() < deadline) {
    await sleep(wait.everyMs);
    const found = await health().catch(() => null);
    if (found === null) stopped = true;
    else if (before === null ? stopped : installationOf(found) !== before) return;
  }
  throw new Error("The hub did not start again after the restore.");
};

/**
 * Restores the backup: the hub checks it again, stops, restores and starts on the restored data,
 * then the page loads again from the restored hub.
 */
export const useRestoreBackup = () =>
  useMutation({
    mutationFn: async (path: string) => {
      const before = installationOf(await call((c) => c.health.health()));
      await call((c) => c.backup.restore({ payload: { path } }));
      await waitForRestoredHub(before);
      globalThis.location.reload();
    },
  });

export const useResumeWork = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => call((c) => c.backup.resume()),
    onSuccess: (status) => queryClient.setQueryData(restoreKey, status),
  });
};

export const useDeleteSetAside = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => call((c) => c.backup.deleteSetAside()),
    onSuccess: (status) => queryClient.setQueryData(restoreKey, status),
  });
};
