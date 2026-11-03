import { formatCount, plural } from "../../lib/format.ts";

/** User-facing copy for backup and restore (STD-I18N-001, ADR 026). */
export const messages = {
  heading: "Backup & export",
  intro: "Your chats, Quests and what hobs made live on the hub. Keep a copy somewhere safe.",
  failedToRead: "Hobbots could not read its backups. Try again in a moment.",
  backup: {
    title: "Back up now",
    destination: "Save the backup in",
    destinationHint: "A folder on the hub, outside every folder hobs work in.",
    choose: "Choose a folder…",
    start: "Back up now",
    starting: "Starting…",
    cancel: "Cancel backup",
    waiting: ({ turns }: { turns: number }) =>
      turns === 1
        ? "Waiting for 1 reply working in the default workspace to end. Hobs with their own folders keep working."
        : `Waiting for ${turns} replies working in the default workspace to end. Hobs with their own folders keep working.`,
    copying: {
      database: "Copying the database…",
      workspace: "Copying the default workspace…",
      activity: "Copying the Workbench…",
      "tool-logs": "Copying the tool logs…",
      manifest: "Finishing the backup…",
    },
    progress: ({ copied, total }: { copied: string; total: string }) => `${copied} of ${total}`,
    done: ({ when, size }: { when: string; size: string }) => `Backed up ${when} · ${size}`,
    failed: ({ reason }: { reason: string }) => `The backup did not finish. ${reason}`,
    privacy:
      "A backup keeps your chats exactly as written, including anything you pasted into a message. It is not encrypted, so keep it somewhere private.",
  },
  holds: {
    title: "What a backup holds",
    kept: [
      "Chats and threads",
      "Quests, Tasks and backpack history",
      "What hobs made, and the Workbench",
      "Hob settings, looks and permissions",
    ],
    left: ["Passwords, keys and tokens (they stay in the keychain)", "Your own folders the hobs worked in"],
  },
  restore: {
    open: "Restore from a backup…",
    title: "Restore from a backup",
    note: "Restoring asks before replacing anything and never runs old work again by itself.",
    path: "Backup folder",
    pathHint: "The folder whose name ends in .hobbots-backup.",
    choose: "Choose a backup…",
    read: "Read the backup",
    reading: "Reading…",
    summaryTitle: "This backup holds",
    made: ({ when, version }: { when: string; version: string }) => `Made ${when} by Hobbots ${version}`,
    counts: ({ hobs, threads, quests, tasks }: { hobs: number; threads: number; quests: number; tasks: number }) => {
      const count = (n: number, one: string, other: string) =>
        plural(n, { one: `${formatCount(n)} ${one}`, other: `${formatCount(n)} ${other}` });
      return `${count(hobs, "hob", "hobs")}, ${count(threads, "thread", "threads")}, ${count(quests, "Quest", "Quests")} and ${count(tasks, "Task", "Tasks")}`;
    },
    missing: "Not on this computer, so set these hobs' folders again after the restore:",
    notBack:
      "Devices, keychain items and runtime sign-ins do not come back: pair your devices and sign in again. Work that waited in the backup is held until you resume it.",
    replaces:
      "The hub stops and starts again on the backup. Its current data is set aside beside it, not deleted, until you delete it.",
    confirm: "Restore and restart",
    restoring: "Restoring… Hobbots starts again in a moment.",
    cancel: "Cancel",
    failed: ({ reason }: { reason: string }) => `Hobbots could not restore the backup. ${reason}`,
  },
  latest: {
    restored: ({ when, made }: { when: string; made: string }) => `Restored ${when} from a backup made ${made}.`,
    held: "Work is held after a restore",
    heldNote:
      "Time passed since the backup, and some of the work in it may already have happened. Nothing that waited starts on its own until you resume work.",
    resume: "Resume work",
    resuming: "Resuming…",
    resumeFailed: "Hobbots could not resume work. Try again in a moment.",
    missing: "Folders the backup named that are not on this computer:",
    setAside: ({ size }: { size: string }) => `The data from before the restore · ${size}`,
    delete: "Delete…",
    deleteConfirm: "Delete the data from before the restore for good?",
    keep: "Keep",
    confirmDelete: "Delete",
    deleting: "Deleting…",
    lastFailed: ({ reason }: { reason: string }) =>
      `The last restore did not happen, and the hub kept its data: ${reason}`,
  },
  welcome: {
    open: "Restore a backup",
  },
} as const;
