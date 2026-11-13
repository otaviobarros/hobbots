import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream, type Dirent } from "node:fs";
import { chmod, lstat, mkdir, readdir, readFile, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, relative, sep } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { MEMORY_ARCHIVE, memoryFolder, replaceMemoryKeys, restoreMemoryArchive } from "@hobbots/memory";
import { knownMigrationIds } from "@hobbots/persistence";
import { Effect, Schema } from "effect";

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
  /**
   * Every migration id the backup's database applied (ADR 040). A backup made before it has none, and
   * its ids were sequential, so its `schemaVersion` alone says whether this Hobbots knows them.
   */
  migrations: Schema.optionalKey(Schema.Array(Schema.Int)),
  installationId: Schema.String,
  counts: Schema.Struct({
    hobs: Schema.Int,
    threads: Schema.Int,
    quests: Schema.Int,
    tasks: Schema.Int,
    /** Skills in the library, not counting the Archive. A backup made before the library has none. */
    skills: Schema.optionalKey(Schema.Int),
  }),
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
  memorySettings: { backup: join("settings", "memory-settings.json"), data: "memory-settings.json" },
} as const;

/**
 * Memory in a backup (ADR 028): the archive its engine made, kept whole. A restore unpacks it into
 * the engine's folder rather than copying it.
 */
export const MEMORY_PART = `memory/${MEMORY_ARCHIVE}`;

/**
 * The skills library's files in a backup (ADR 029): each revision's folder, as `skills/<hash>/` in the
 * backup and `skills/objects/<hash>/` in the data folder. The library's rows come with the database.
 * A file keeps whether it runs, since a revision's hash covers that, and a restore makes each folder
 * read-only again, as the hub wrote it.
 */
export const SKILLS_PART = { backup: "skills", data: join("skills", "objects") } as const;

/** A revision's folder in the object store: its SHA-256. A half-written one is still named `.staging-…`. */
const REVISION_FOLDER = /^[0-9a-f]{64}$/;

/**
 * The entries of the data folder that are the hub's own, which a restore moves aside and Start over
 * deletes. The desktop app keeps its window's own files in the same folder, and they stay where they
 * are.
 */
export const HUB_ENTRIES = [
  "hobbots.sqlite",
  "hobbots.sqlite-wal",
  "hobbots.sqlite-shm",
  "activity",
  "tool-logs",
  "workspaces",
  "network.json",
  "memory-settings.json",
  "memory",
  "memory-keys",
  "skills",
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
const copyFile = async (
  source: string,
  target: string,
  onBytes: (n: number) => void = () => {},
  mode: number = 0o600,
) => {
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
  await pipeline(createReadStream(source), tap, createWriteStream(target, { flags: "wx", mode }));
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

/** Owner-only, and runnable when the file it was copied from could be run. */
const modeOf = async (source: string) => (((await lstat(source)).mode & 0o100) === 0 ? 0o600 : 0o700);

/**
 * Copies each revision's folder of the skills object store into `target`, owner-only, and returns
 * each file's entry for the manifest under `skills/`. A file that runs stays one, since the
 * revision's hash covers it. A folder still being written, which is not named by its hash yet, is
 * left out: no record names it. With `only`, so is each revision not in it: the backup holds the
 * revisions its snapshot of the database names, never those of skills from `~/.agents/skills`, which
 * stay in that folder (ADR 029), nor one written after the snapshot.
 */
export const copySkillObjects = async (
  source: string,
  target: string,
  onBytes: (n: number) => void = () => {},
  only: ReadonlySet<string> | null = null,
): Promise<ReadonlyArray<ManifestFile>> => {
  const entries: Array<ManifestFile> = [];
  for (const file of await listFiles(source)) {
    const revision = file.split(sep)[0] ?? "";
    if (!REVISION_FOLDER.test(revision) || (only !== null && !only.has(revision))) continue;
    const from = join(source, file);
    const copied = await copyFile(from, join(target, file), onBytes, await modeOf(from));
    entries.push({ path: join(SKILLS_PART.backup, file).split(sep).join("/"), ...copied });
  }
  return entries;
};

/** Makes every folder under `path` writable again, so a read-only tree, such as a revision an earlier hub sealed, can be removed. */
const openFolders = async (path: string): Promise<void> => {
  const stat = await lstat(path).catch(() => undefined);
  if (stat === undefined || !stat.isDirectory()) return;
  await chmod(path, 0o700);
  for (const entry of await readdir(path)) await openFolders(join(path, entry));
};

/**
 * Removes `path` and everything under it, read-only folders included: a hub before #1196 sealed each
 * skill revision's folders read-only (ADR 029), which `rm` alone cannot delete. A missing path is no error.
 */
export const removeTree = async (path: string) => {
  await openFolders(path);
  await rm(path, { recursive: true, force: true });
};

/**
 * Makes a restored revision's files read-only, as the hub wrote them: `0444`, or `0555` for one that
 * runs. Its folders are `0755`, writable to their owner, so the data folder can be removed (#1196).
 */
const sealRevision = async (folder: string): Promise<void> => {
  await chmod(folder, 0o755);
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    const path = join(folder, entry.name);
    if (entry.isDirectory()) await sealRevision(path);
    else await chmod(path, ((await lstat(path)).mode & 0o100) === 0 ? 0o444 : 0o555);
  }
};

/**
 * Restores the skills object store from a backup's `skills/` files into `<dataDir>/skills/objects`:
 * each file keeps whether it runs and is read-only again.
 */
const restoreSkillObjects = async (dataDir: string, backup: string, manifest: BackupManifest) => {
  const objects = join(dataDir, SKILLS_PART.data);
  const files = manifest.files.filter((file) => file.path.startsWith(`${SKILLS_PART.backup}/`));
  if (files.length === 0) return;
  await mkdir(objects, { recursive: true, mode: 0o700 });
  await chmod(dirname(objects), 0o700);
  const revisions = new Set<string>();
  for (const file of files) {
    const inner = file.path.slice(SKILLS_PART.backup.length + 1);
    const from = join(backup, file.path);
    await copyFile(from, join(objects, ...inner.split("/")), () => {}, await modeOf(from));
    revisions.add(inner.split("/")[0] ?? "");
  }
  for (const revision of revisions) if (REVISION_FOLDER.test(revision)) await sealRevision(join(objects, revision));
};

/** Writes the manifest last, owner-only. */
export const writeManifest = (folder: string, manifest: BackupManifest) =>
  writeFile(join(folder, "manifest.json"), `${encodeManifest(manifest)}\n`, { flag: "wx", mode: 0o600 });

/**
 * Whether a backup's database is newer than this Hobbots: a higher schema version, or since ADR 040
 * a migration id it does not know, which a newer Hobbots can add below the highest this one knows.
 */
const isNewerSchema = (manifest: BackupManifest, knownSchema: number, knownIds: ReadonlySet<number>) =>
  manifest.schemaVersion > knownSchema || (manifest.migrations ?? []).some((id) => !knownIds.has(id));

/** Why a backup folder cannot be restored, in words for the restore screen. */
export class NotRestorable extends Error {}

/**
 * Reads and checks a backup before anything changes: its manifest, every file it names by size and
 * SHA-256, and that nothing in it is a link that could lead outside it. A newer schema than
 * `knownSchema` is refused, and so is a migration id outside `knownIds`: since ADR 040 a newer
 * Hobbots can add one below the highest this one knows.
 */
export const readBackup = async (
  folder: string,
  knownSchema: number,
  knownIds: ReadonlySet<number> = knownMigrationIds(),
): Promise<BackupManifest> => {
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
  if (isNewerSchema(manifest, knownSchema, knownIds)) {
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
    await removeTree(join(dataDir, entry));
  }
  for (const entry of moved) await rename(join(setAside, entry), join(dataDir, entry)).catch(() => undefined);
  if (madeSetAside) await rmdir(setAside).catch(() => undefined);
};

/**
 * Restores a checked backup into `dataDir`, with no hub running there (ADR 026): moves the hub's own
 * entries aside into `<dataDir>.before-restore-<date>`, copies the backup in owner-only, puts back the
 * skills library's revisions read-only (ADR 029), unpacks its memory, writes a new installation ID,
 * new memory bearers (ADR 028) and the marker the next start applies. A failure puts everything back as it was.
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
    await restoreSkillObjects(dataDir, backup, manifest);
    if (manifest.files.some((file) => file.path === MEMORY_PART)) {
      await Effect.runPromise(
        restoreMemoryArchive(join(backup, MEMORY_PART), memoryFolder(dataDir)).pipe(
          Effect.mapError((refused) => new NotRestorable(`The backup's memory cannot be restored: ${refused.reason}.`)),
        ),
      );
    }
    // The old bearers are left behind with the data set aside, so they no longer reach memory.
    replaceMemoryKeys(dataDir);
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
