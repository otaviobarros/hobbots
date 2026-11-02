import { ActivityDetailNotFound, type AttemptNotFound } from "@hobbots/api";
import {
  type AttemptActivity,
  AttemptFiles,
  type AttemptId,
  type FileNow,
  fileCandidates,
  type PlacedArtifact,
  PREVIEW_TEXT_BYTES,
  previewMediaType,
  type TaskFile,
  type TaskFileId,
  taskFile,
} from "@hobbots/domain";
import { Context, Effect, Layer, Option } from "effect";
import { ActivityRepository } from "./activity.ts";
import { readAttemptActivity } from "./activity-reads.ts";
import { effectiveFolders } from "./permissions.ts";
import { FolderChecks, InstallationSettings } from "./ports.ts";
import { HobbotsRepository } from "./repository.ts";
import { makeRedactor, SecretRedaction } from "./secrets.ts";

/**
 * Reads the files a Task made or touched, as they are now in the hob's folders, for the Workbench's
 * Files tab (ADR 023). Only a file inside one of the hob's folders, reached through no link, is
 * listed or served.
 */
export interface HobFilesShape {
  /**
   * Where a path a Task named sits among `folders` (canonical): resolved as the policy resolves a
   * path, a relative one against the first folder. None when it is outside all of them.
   */
  readonly place: (
    folders: ReadonlyArray<string>,
    value: string,
  ) => Effect.Effect<Option.Option<{ readonly folder: string; readonly path: string }>>;
  /** The size and SHA-256 of a regular file inside `folder` now; none when it is not one. */
  readonly look: (folder: string, path: string) => Effect.Effect<Option.Option<FileNow>>;
  /** The first `maxBytes` of a regular file inside `folder` now, reached through no link. */
  readonly read: (folder: string, path: string, maxBytes: number) => Effect.Effect<Option.Option<Uint8Array>>;
}

/** The hob's folders on the hub, as the Files tab reads them. */
export class HobFiles extends Context.Service<HobFiles, HobFilesShape>()("@hobbots/agents/HobFiles") {}

/** A file's contents as the hub serves them: for a preview, or as the file itself for a download. */
export interface ServedFile {
  readonly file: TaskFile;
  readonly bytes: Uint8Array;
  readonly mediaType: string;
}

export type FilePurpose = "preview" | "download";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Whether `location` is `folder` or inside it, by spelling: both are canonical. */
const within = (location: string, folder: string) =>
  location === folder || location.startsWith(folder.endsWith("/") ? folder : `${folder}/`);

export class TaskFiles extends Context.Service<
  TaskFiles,
  {
    /** The files an Attempt made or touched, as they are now. */
    readonly list: (attemptId: AttemptId) => Effect.Effect<AttemptFiles, AttemptNotFound>;
    /**
     * One listed file's contents. A preview serves only the kinds the Files tab previews, text
     * redacted and cut to its first MiB; a download serves the file as it is. A file whose name
     * marks it as secret, or past the size the hub serves, is never served.
     */
    readonly serve: (
      attemptId: AttemptId,
      fileId: TaskFileId,
      purpose: FilePurpose,
    ) => Effect.Effect<ServedFile, ActivityDetailNotFound>;
  }
>()("@hobbots/agents/TaskFiles") {
  static readonly layer = Layer.effect(
    TaskFiles,
    Effect.gen(function* () {
      const activities = yield* ActivityRepository;
      const repo = yield* HobbotsRepository;
      const setup = yield* InstallationSettings;
      const folderChecks = yield* FolderChecks;
      const files = yield* HobFiles;
      // Without the hub's redactor, secret shapes are still redacted.
      const redactor = Option.getOrElse(yield* Effect.serviceOption(SecretRedaction), () => makeRedactor());

      /** The hob's folders now, canonical; none once the hob is gone. */
      const foldersOf = (activity: AttemptActivity) =>
        Effect.gen(function* () {
          const agent = yield* repo.findAgent(activity.attempt.agentId);
          if (Option.isNone(agent)) return [];
          const { approvedFolders } = yield* setup.get;
          const folders = yield* effectiveFolders(folderChecks, approvedFolders, agent.value.policy);
          return [...new Set(yield* Effect.forEach(folders, folderChecks.identity))];
        });

      const placedArtifacts = (activity: AttemptActivity, folders: ReadonlyArray<string>) =>
        Effect.forEach(
          activity.artifacts.filter((artifact) => artifact.kind === "file"),
          (artifact) =>
            Effect.map(
              files.place(folders, artifact.value),
              Option.map((at): PlacedArtifact => ({ artifactId: artifact.id, label: artifact.label, ...at })),
            ),
        ).pipe(Effect.map((placed) => placed.flatMap((each) => (Option.isSome(each) ? [each.value] : []))));

      const listFor = (activity: AttemptActivity) =>
        Effect.gen(function* () {
          const folders = yield* foldersOf(activity);
          const placed = yield* placedArtifacts(activity, folders);
          // A change recorded in a folder the hob no longer works in is not listed.
          const candidates = fileCandidates(activity, placed).filter((candidate) =>
            folders.some((folder) => within(candidate.folder, folder)),
          );
          const listed = yield* Effect.forEach(
            candidates,
            (candidate) =>
              Effect.map(files.look(candidate.folder, candidate.path), (found) =>
                taskFile(candidate, Option.getOrNull(found)),
              ),
            { concurrency: 8 },
          );
          return new AttemptFiles({ attemptId: activity.attempt.id, files: listed });
        });

      const list = (attemptId: AttemptId) => Effect.flatMap(readAttemptActivity(activities, attemptId), listFor);

      const serve = (attemptId: AttemptId, fileId: TaskFileId, purpose: FilePurpose) =>
        Effect.gen(function* () {
          const missing = new ActivityDetailNotFound({ attemptId });
          const listed = yield* list(attemptId).pipe(Effect.mapError(() => missing));
          const file = listed.files.find((each) => each.id === fileId);
          if (file === undefined || file.notServed !== null || file.now === "gone" || file.size === null) {
            return yield* missing;
          }
          const mediaType = purpose === "preview" ? previewMediaType(file.path) : "application/octet-stream";
          if (mediaType === null) return yield* missing;
          const text = file.preview === "text" || file.preview === "markdown";
          const limit = purpose === "preview" && text ? Math.min(file.size, PREVIEW_TEXT_BYTES) : file.size;
          const bytes = yield* files.read(file.folder, file.path, limit);
          if (Option.isNone(bytes)) return yield* missing;
          if (purpose === "download" || !text) return { file, bytes: bytes.value, mediaType };
          // Text is shown redacted, as a tool's output is (ADR 023).
          return { file, bytes: encoder.encode(redactor.text(decoder.decode(bytes.value))), mediaType };
        });

      return TaskFiles.of({ list, serve });
    }),
  );
}
