import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream, type Dirent } from "node:fs";
import { chmod, lstat, mkdir, readdir, readFile, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, relative, sep } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { Schema } from "effect";

/** The format of a backup's manifest (ADR 026). A later format, such as an encrypted one, gets a new version. */
export const BACKUP_FORMAT = "hobbots.backup";

const ManifestFile = Schema.Struct({ path: Schema.String, size: Schema.Number, sha256: Schema.String });
export type ManifestFile = typeof ManifestFile.Type;

const ManifestFolders = Schema.Struct({
  agentId: Schema.String,
  name: Schema.String,
  folders: Schema.Array(Schema.String),
});

/** What `manifest.json` holds: written last, so a backup folder without one is incomplete. */
export const BackupManifest = Schema.Struct({
  format: Schema.Literal(BACKUP_FORMAT),
  version: Schema.Literal(1),
  createdAt: Schema.String,
  hobbotsVersion: Schema.String,
  storage: Schema.Literal("sqlite"),
  database: Schema.Literals(["included", "external"]),
  schemaVersion: Schema.Int,
  installationId: Schema.String,
  counts: Schema.Struct({ hobs: Schema.Int, threads: Schema.Int, quests: Schema.Int, tasks: Schema.Int }),
  hobFolders: Schema.Array(ManifestFolders),
  files: Schema.Array(ManifestFile),
});
export type BackupManifest = typeof BackupManifest.Type;

const ManifestJson = Schema.fromJsonString(BackupManifest);
const decodeManifest = Schema.decodeUnknownSync(ManifestJson);
const encodeManifest = Schema.encodeSync(ManifestJson);

/** Where each part of a backup lives in the backup folder, and in the data folder it restores into. */
export const BACKUP_PARTS = {
  database: { backup: "database.sqlite", data: "hobbots.sqlite" },
  workspace: { backup: "workspace", data: join("workspaces", "default") },
  activity: { backup: "activity", data: "activity" },
  toolLogs: { backup: "tool-logs", data: "tool-logs" },
  network: { backup: join("settings", "network.json"), data: "network.json" },
} as const;

/**
 * The entries of the data folder that are the hub's own, which a restore moves aside. The desktop
 * app keeps its window's own files in the same folder, and they stay where they are.
 */
const HUB_ENTRIES = [
  "hobbots.sqlite",
  "hobbots.sqlite-wal",
  "hobbots.sqlite-shm",
  "activity",
  "tool-logs",
  "workspaces",
  "network.json",
  "installation-id",
  "window-key",
  "charms",
  "backups",
  "restore.json",
  "fake-tailscale.json",
] as const;

/** The file a restore leaves in the new data folder, which the hub's next start applies and deletes. */
export const restoreMarkerFile = (dataDir: string) => join(dataDir, "restore.json");

const pad = (n: number) => String(n).padStart(2, "0");

/** `2026-11-03 14.05.09`: readable, sorts by time, and valid in a file name on every system. */
export const fileStamp = (at: Date) =>
  `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}.${pad(at.getMinutes())}.${pad(at.getSeconds())}`;

export const backupFolderName = (at: Date) => `Hobbots backup ${fileStamp(at)}.hobbots-backup`;

/** True when `child` is `parent` or inside it. Both are canonical paths. */
export const isInside = (child: string, parent: string) => {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

/** A manifest path that stays inside the backup folder: relative, normalized, with no `..`. */
const safeRelative = (path: string) => {
  if (path === "" || isAbsolute(path) || path.includes("\0")) return false;
  const normal = normalize(path);
  return normal === path.split("/").join(sep) && !normal.split(sep).includes("..");
};

/** Every regular file under `root`, relative to it. Links and other special files are left out. */
export const listFiles = async (root: string, under = ""): Promise<ReadonlyArray<string>> => {
  let entries: Array<Dirent>;
  try {
    entries = await readdir(join(root, under), { withFileTypes: true, encoding: "utf8" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const found: Array<string> = [];
  for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const path = join(under, entry.name);
    if (entry.isDirectory()) found.push(...(await listFiles(root, path)));
    else if (entry.isFile()) found.push(path);
  }
  return found;
};

/** The bytes of every regular file under `path`, or of the file itself. */
export const sizeOf = async (path: string): Promise<number> => {
  let stat: Awaited<ReturnType<typeof lstat>>;
  try {
    stat = await lstat(path);
  } catch {
    return 0;
  }
  if (stat.isFile()) return stat.size;
  if (!stat.isDirectory()) return 0;
  let total = 0;
  for (const file of await listFiles(path)) total += (await lstat(join(path, file))).size;
  return total;
};

/**
 * Copies one file owner-only, never over an existing one, and returns its size and SHA-256. `onBytes`
 * hears of every chunk, for progress.
 */
const copyFile = async (source: string, target: string, onBytes: (n: number) => void = () => {}) => {
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  const hash = createHash("sha256");
  let size = 0;
  const tap = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      hash.update(chunk);
      size += chunk.length;
      onBytes(chunk.length);
      done(null, chunk);
    },
  });
  await pipeline(createReadStream(source), tap, createWriteStream(target, { flags: "wx", mode: 0o600 }));
  return { size, sha256: hash.digest("hex") };
};

/** The SHA-256 and size of a file, read in chunks. */
export const hashFile = async (path: string) => {
  const hash = createHash("sha256");
  let size = 0;
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk as Buffer);
    size += (chunk as Buffer).length;
  }
  return { size, sha256: hash.digest("hex") };
};

/**
 * Copies every regular file under `source` into `target`, owner-only, and returns each one's entry
 * for the manifest, named under `prefix`. A missing source copies nothing.
 */
export const copyTree = async (
  source: string,
  target: string,
  prefix: string,
  onBytes: (n: number) => void = () => {},
): Promise<ReadonlyArray<ManifestFile>> => {
  await mkdir(target, { recursive: true, mode: 0o700 });
  const entries: Array<ManifestFile> = [];
  for (const file of await listFiles(source)) {
    const copied = await copyFile(join(source, file), join(target, file), onBytes);
    entries.push({ path: join(prefix, file).split(sep).join("/"), ...copied });
  }
  return entries;
};

/** Writes the manifest last, owner-only. */
export const writeManifest = (folder: string, manifest: BackupManifest) =>
  writeFile(join(folder, "manifest.json"), `${encodeManifest(manifest)}\n`, { flag: "wx", mode: 0o600 });

/** Why a backup folder cannot be restored, in words for the restore screen. */
export class NotRestorable extends Error {}

/**
 * Reads and checks a backup before anything changes: its manifest, every file it names by size and
 * SHA-256, and that nothing in it is a link that could lead outside it. A newer schema than
 * `knownSchema` is refused.
 */
export const readBackup = async (folder: string, knownSchema: number): Promise<BackupManifest> => {
  const stat = await lstat(folder).catch(() => undefined);
  if (stat === undefined || !stat.isDirectory()) throw new NotRestorable("There is no backup folder at that path.");
  let manifest: BackupManifest;
  try {
    manifest = decodeManifest(await readFile(join(folder, "manifest.json"), "utf8"));
  } catch {
    throw new NotRestorable(
      "This folder is not a complete Hobbots backup: its manifest is missing or unreadable. A backup that stopped before it finished has none.",
    );
  }
  if (manifest.schemaVersion > knownSchema) {
    throw new NotRestorable("This backup is from a newer Hobbots. Update Hobbots first.");
  }
  if (manifest.database !== "included") {
    throw new NotRestorable(
      "This backup holds no database. Restore the database with PostgreSQL's own tools, then run the restore command.",
    );
  }
  for (const file of manifest.files) {
    if (!safeRelative(file.path)) throw new NotRestorable(`The backup names a file outside it: ${file.path}`);
    const path = join(folder, file.path);
    const parts = file.path.split("/");
    for (let i = 1; i <= parts.length; i++) {
      const at = await lstat(join(folder, ...parts.slice(0, i))).catch(() => undefined);
      if (at === undefined) throw new NotRestorable(`The backup is missing ${file.path}.`);
      if (at.isSymbolicLink()) throw new NotRestorable(`The backup holds a link at ${file.path}.`);
    }
    const found = await hashFile(path);
    if (found.size !== file.size || found.sha256 !== file.sha256) {
      throw new NotRestorable(`${file.path} does not match the backup's checksum. The backup is damaged.`);
    }
  }
  if (!manifest.files.some((file) => file.path === BACKUP_PARTS.database.backup)) {
    throw new NotRestorable("The backup is missing its database.");
  }
  return manifest;
};

/** What a restore leaves for the hub's next start, which applies it once (ADR 026). */
const RestoreMarker = Schema.Struct({
  id: Schema.String,
  restoredAt: Schema.String,
  backupMadeAt: Schema.String,
  backupVersion: Schema.String,
  setAside: Schema.NullOr(Schema.String),
  missingFolders: Schema.Array(Schema.String),
});
type RestoreMarker = typeof RestoreMarker.Type;
const MarkerJson = Schema.fromJsonString(RestoreMarker);
export const decodeMarker = Schema.decodeUnknownSync(MarkerJson);
const encodeMarker = Schema.encodeSync(MarkerJson);

/** The hob folders the manifest names that are not on this computer. */
export const missingFolders = async (manifest: BackupManifest) => {
  const missing: Array<string> = [];
  for (const folder of new Set(manifest.hobFolders.flatMap((hob) => hob.folders))) {
    const stat = await lstat(folder).catch(() => undefined);
    if (stat === undefined || !stat.isDirectory()) missing.push(folder);
  }
  return missing;
};

const exists = (path: string) =>
  lstat(path).then(
    () => true,
    () => false,
  );

/**
 * Undoes a restore that failed: removes each hub entry the restore wrote, never one of the entries
 * that were there and not yet moved, moves the moved ones back, and removes the set-aside folder
 * once it is empty again.
 */
const putBack = async (
  dataDir: string,
  setAside: string,
  originals: ReadonlyArray<string>,
  moved: ReadonlyArray<string>,
  madeSetAside: boolean,
) => {
  for (const entry of HUB_ENTRIES) {
    if (originals.includes(entry) && !moved.includes(entry)) continue;
    await rm(join(dataDir, entry), { recursive: true, force: true });
  }
  for (const entry of moved) await rename(join(setAside, entry), join(dataDir, entry)).catch(() => undefined);
  if (madeSetAside) await rmdir(setAside).catch(() => undefined);
};

/**
 * Restores a checked backup into `dataDir`, with no hub running there (ADR 026): moves the hub's own
 * entries aside into `<dataDir>.before-restore-<date>`, copies the backup in owner-only, writes a new
 * installation ID and the marker the next start applies. A failure puts everything back as it was.
 * Returns the folder set aside, or null when the data folder held nothing of the hub's.
 */
export const restoreInto = async (
  dataDir: string,
  backup: string,
  manifest: BackupManifest,
  at: Date,
): Promise<string | null> => {
  const setAside = `${dataDir}.before-restore-${fileStamp(at).replace(" ", "-")}`;
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  // The hub's entries as they were: a failure puts back exactly these and removes only what the
  // restore itself wrote.
  const originals: Array<string> = [];
  for (const entry of HUB_ENTRIES) if (await exists(join(dataDir, entry))) originals.push(entry);
  const moved: Array<string> = [];
  let madeSetAside = false;
  try {
    if (originals.length > 0) {
      // Never into a folder that is already there, which a failure would then remove.
      await mkdir(setAside, { mode: 0o700 });
      madeSetAside = true;
    }
    for (const entry of originals) {
      await rename(join(dataDir, entry), join(setAside, entry));
      moved.push(entry);
    }
    for (const part of Object.values(BACKUP_PARTS)) {
      const target = join(dataDir, part.data);
      const wanted = manifest.files.filter(
        (file) => file.path === part.backup || file.path.startsWith(`${part.backup.split(sep).join("/")}/`),
      );
      for (const file of wanted) {
        const into = file.path === part.backup ? target : join(target, relative(part.backup, file.path));
        await copyFile(join(backup, file.path), into);
      }
      if (part === BACKUP_PARTS.workspace) await mkdir(target, { recursive: true, mode: 0o700 });
    }
    await writeFile(join(dataDir, "installation-id"), `${randomUUID()}\n`, { flag: "wx", mode: 0o600 });
    const marker: RestoreMarker = {
      id: randomUUID(),
      restoredAt: at.toISOString(),
      backupMadeAt: manifest.createdAt,
      backupVersion: manifest.hobbotsVersion,
      setAside: moved.length === 0 ? null : setAside,
      missingFolders: await missingFolders(manifest),
    };
    await writeFile(restoreMarkerFile(dataDir), `${encodeMarker(marker)}\n`, { flag: "wx", mode: 0o600 });
    await chmod(dataDir, 0o700);
    return marker.setAside;
  } catch (error) {
    await putBack(dataDir, setAside, originals, moved, madeSetAside);
    throw error;
  }
};
