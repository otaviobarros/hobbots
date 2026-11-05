import { readFileSync, rmSync, writeFileSync } from "node:fs";
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

/** Records this process as the hub of the data folder, on the port it is about to listen on. */
export const recordHubPresence = (dataDir: string, port: number) =>
  Effect.sync(() =>
    writeFileSync(hubPresenceFile(dataDir), `${JSON.stringify({ pid: process.pid, port })}\n`, { mode: 0o600 }),
  );

/**
 * Removes the file when the hub stops, if it is still this process's: a second hub started on the
 * same folder may have written its own. A hub that crashes leaves it, and its process is then gone.
 */
export const forgetHubPresence = (dataDir: string) =>
  Effect.sync(() => {
    if (readHubPresence(dataDir)?.pid === process.pid) rmSync(hubPresenceFile(dataDir), { force: true });
  });
