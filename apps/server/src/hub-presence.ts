import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Effect, Option, Schema } from "effect";

/**
 * The file a running hub keeps in its data folder (#999): its process and the port it listens on.
 * The command-line tools read it to know a hub is using the folder whatever its port, and it is not
 * one of the hub's own entries, so a restore or Start over leaves it where it is.
 */
export const hubPresenceFile = (dataDir: string) => join(dataDir, "hub.json");

const HubPresence = Schema.Struct({
  pid: Schema.Int.check(Schema.isGreaterThan(0)),
  port: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 })),
});

/** The process and port a hub of this data folder recorded. */
export type HubPresence = typeof HubPresence.Type;

const decodePresence = Schema.decodeUnknownOption(Schema.fromJsonString(HubPresence));

/** What the file records, or undefined when there is none or it cannot be read. */
export const readHubPresence = (dataDir: string): HubPresence | undefined => {
  try {
    return Option.getOrUndefined(decodePresence(readFileSync(hubPresenceFile(dataDir), "utf8")));
  } catch {
    return undefined;
  }
};

/** Whether a process with this ID exists. One of another user still exists, though it cannot be signalled. */
export const processAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

/** Another hub process is alive and recorded as using the data folder, so this one must not start. */
class HubAlreadyRunning extends Schema.TaggedError<HubAlreadyRunning>()("HubAlreadyRunning", {
  dataDir: Schema.String,
  pid: Schema.Number,
  port: Schema.Number,
}) {
  override get message() {
    return `Another hub (process ${this.pid}, port ${this.port}) is using ${this.dataDir}. Stop it first.`;
  }
}

/** Written beside the file and renamed over it, so a reader never sees half a record. */
const write = (dataDir: string, port: number) => {
  const file = hubPresenceFile(dataDir);
  writeFileSync(`${file}.${process.pid}.tmp`, `${JSON.stringify({ pid: process.pid, port })}\n`, { mode: 0o600 });
  renameSync(`${file}.${process.pid}.tmp`, file);
};

/** Creates the record when there is none yet. Answers whether it did. */
const createFirst = (dataDir: string, port: number) => {
  try {
    writeFileSync(hubPresenceFile(dataDir), `${JSON.stringify({ pid: process.pid, port })}\n`, {
      mode: 0o600,
      flag: "wx",
    });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
};

/**
 * Records this process as the hub of the data folder, on the port it is about to listen on. Fails
 * while another live process holds the record, and leaves that record as it is: a second hub on the
 * same folder must not take the first one's place. A record of a process that is gone is replaced.
 */
export const claimHubPresence = (dataDir: string, port: number) =>
  Effect.gen(function* () {
    // Made only when there is none, so of two hubs starting at once, one finds the other's record.
    if (createFirst(dataDir, port)) return;
    const current = readHubPresence(dataDir);
    if (current !== undefined && current.pid !== process.pid && processAlive(current.pid)) {
      return yield* new HubAlreadyRunning({ dataDir, pid: current.pid, port: current.port });
    }
    write(dataDir, port);
  });

/** Records the port the hub moved to, when the record is still this process's. */
export const recordHubPort = (dataDir: string, port: number) =>
  Effect.sync(() => {
    if (readHubPresence(dataDir)?.pid === process.pid) write(dataDir, port);
  });

/**
 * Removes the file when the hub stops, if it is still this process's. A hub that crashes leaves it,
 * and its process is then gone.
 */
export const forgetHubPresence = (dataDir: string) =>
  Effect.sync(() => {
    if (readHubPresence(dataDir)?.pid === process.pid) rmSync(hubPresenceFile(dataDir), { force: true });
  });
