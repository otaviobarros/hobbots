import { describe, expect, it } from "vitest";
import { backupRunning, waitForRestoredHub, workHeld } from "./backup.ts";

/** A clock that moves only when the page sleeps, and a hub that answers each look with the next answer. */
const hubAnswering = (answers: ReadonlyArray<object | null>) => {
  let now = 0;
  let looks = 0;
  const realNow = Date.now;
  Date.now = () => now;
  return {
    health: async () => {
      const answer = answers[Math.min(looks++, answers.length - 1)];
      if (answer === null || answer === undefined) throw new Error("down");
      return answer;
    },
    sleep: async (ms: number) => {
      now += ms;
    },
    looks: () => looks,
    restore: () => {
      Date.now = realNow;
    },
  };
};

const wait = { timeoutMs: 10_000, everyMs: 1000 };

describe("waiting for the restored hub", () => {
  // covers OP-003
  it("[TC-OP-034] reloads once the hub answers with a new installation, or answers again after it stopped", async () => {
    const renamed = hubAnswering([
      { installationId: "old" },
      null,
      { installationId: "old" },
      { installationId: "new" },
    ]);
    try {
      await waitForRestoredHub("old", renamed.health, wait, renamed.sleep);
      expect(renamed.looks()).toBe(4);
    } finally {
      renamed.restore();
    }
    // Where the installation is not shown, the hub must stop and answer again.
    const hidden = hubAnswering([{ app: "hobbots" }, null, null, { app: "hobbots" }]);
    try {
      await waitForRestoredHub(null, hidden.health, wait, hidden.sleep);
      expect(hidden.looks()).toBe(4);
    } finally {
      hidden.restore();
    }
  });

  // covers OP-003
  it("[TC-OP-035] gives up when the hub does not start again, and reads backup and restore states", async () => {
    const gone = hubAnswering([null]);
    try {
      await expect(waitForRestoredHub("old", gone.health, wait, gone.sleep)).rejects.toThrow(
        "The hub did not start again after the restore.",
      );
      expect(gone.looks()).toBe(10);
    } finally {
      gone.restore();
    }
    expect(backupRunning({ _tag: "Waiting", turns: 1, since: "2026-11-03T10:00:00.000Z" })).toBe(true);
    expect(backupRunning({ _tag: "Copying", step: "database", copiedBytes: 0, totalBytes: 10 })).toBe(true);
    expect(backupRunning({ _tag: "Idle" })).toBe(false);
    expect(backupRunning(undefined)).toBe(false);
    expect(workHeld(undefined)).toBe(false);
    expect(workHeld({ latest: null, failed: null })).toBe(false);
    const latest = {
      restoredAt: "2026-11-03T12:00:00.000Z",
      backupMadeAt: "2026-11-03T10:00:00.000Z",
      backupVersion: "0.15.0",
      setAside: null,
      missingFolders: [],
    };
    expect(workHeld({ latest: { ...latest, workHeld: true }, failed: null })).toBe(true);
    expect(workHeld({ latest: { ...latest, workHeld: false }, failed: null })).toBe(false);
  });
});
