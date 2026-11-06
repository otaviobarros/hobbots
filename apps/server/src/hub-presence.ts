import { mkdirSync, readFileSync, renameSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Effect, Option, Schedule, Schema } from "effect";

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

/**
 * A folder a hub holds while it checks and replaces the record, made with `mkdir`, which only one
 * process can do at a time. So of two hubs starting together, one claims the folder and the other
 * finds its record. A hub holds it for as long as one read and one write take.
 */
export const hubClaimLock = (dataDir: string) => join(dataDir, "hub.json.lock");

/**
 * What the file holds: the record, "none" when there is no file, or "unreadable" when there is one
 * that does not decode. The hub writes the record whole, so an unreadable file was changed by hand
 * or damaged, and no one can tell from it whether a hub is running.
 */
export const inspectHubPresence = (dataDir: string): HubPresence | "none" | "unreadable" => {
  let text: string;
  try {
    text = readFileSync(hubPresenceFile(dataDir), "utf8");
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? "none" : "unreadable";
  }
  return Option.getOrElse(decodePresence(text), () => "unreadable" as const);
};

/** What the file records, or undefined when there is none or it cannot be read. */
export const readHubPresence = (dataDir: string): HubPresence | undefined => {
  const current = inspectHubPresence(dataDir);
  return typeof current === "string" ? undefined : current;
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

/** This hub must not start on the data folder: another hub holds it, or no one can tell whether one does. */
class HubPresenceRefused extends Schema.TaggedError<HubPresenceRefused>()("HubPresenceRefused", {
  reason: Schema.String,
}) {
  override get message() {
    return this.reason;
  }
}

/** Written beside the file and renamed over it, so a reader never sees half a record. */
const write = (dataDir: string, port: number) => {
  const file = hubPresenceFile(dataDir);
  writeFileSync(`${file}.${process.pid}.tmp`, `${JSON.stringify({ pid: process.pid, port })}\n`, { mode: 0o600 });
  renameSync(`${file}.${process.pid}.tmp`, file);
};

/** Takes the claim lock, waiting up to two seconds for another hub to let it go. */
const lock = (dataDir: string) =>
  Effect.try({
    try: () => mkdirSync(hubClaimLock(dataDir)),
    catch: (error) => error as NodeJS.ErrnoException,
  }).pipe(
    Effect.retry({ while: (error) => error.code === "EEXIST", schedule: Schedule.spaced("50 millis"), times: 40 }),
    Effect.mapError(
      (error) =>
        new HubPresenceRefused({
          reason:
            error.code === "EEXIST"
              ? `Another hub is starting on ${dataDir}. If none is, delete ${hubClaimLock(dataDir)}.`
              : `${hubClaimLock(dataDir)} could not be made: ${error.message}`,
        }),
    ),
  );

/**
 * Records this process as the hub of the data folder, on the port it is about to listen on. Fails
 * while another live process holds the record, and leaves that record as it is: a second hub on the
 * same folder must not take the first one's place. A record of a process that is gone is replaced.
 * A record that cannot be read fails too, since it may be a running hub's. The check and the write
 * happen under the claim lock, so two hubs starting together cannot both pass the check.
 */
export const claimHubPresence = (dataDir: string, port: number) =>
  Effect.acquireUseRelease(
    lock(dataDir),
    () =>
      Effect.gen(function* () {
        const current = inspectHubPresence(dataDir);
        if (current === "unreadable") {
          return yield* new HubPresenceRefused({
            reason: `${hubPresenceFile(dataDir)} cannot be read, so a hub may be using ${dataDir}. If none is, delete it.`,
          });
        }
        if (current !== "none" && current.pid !== process.pid && processAlive(current.pid)) {
          return yield* new HubPresenceRefused({
            reason: `Another hub (process ${current.pid}, port ${current.port}) is using ${dataDir}. Stop it first.`,
          });
        }
        write(dataDir, port);
      }),
    () => Effect.sync(() => rmdirSync(hubClaimLock(dataDir))),
  );

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
