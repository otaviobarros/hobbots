import { ArtifactContentUnavailable, ArtifactNotFound } from "@hobbots/api";
import {
  type Artifact,
  type ArtifactContentRefusal,
  type ArtifactVersions,
  artifactVersions,
  isFileLocator,
  isImageFile,
  isSecretFile,
  PREVIEW_TEXT_BYTES,
  previewOf,
  type RegisteredArtifactId,
  SERVED_FILE_BYTES,
  type StoredVersion,
  type ThreadId,
} from "@hobbots/domain";
import { Context, Effect, Layer, Option } from "effect";
import { ActivityStore } from "./activity.ts";
import { hobFoldersNow } from "./permissions.ts";
import { FolderChecks, InstallationSettings } from "./ports.ts";
import { RecordRepository } from "./records.ts";
import { HobbotsRepository } from "./repository.ts";
import { makeRedactor, SecretRedaction } from "./secrets.ts";
import { HobFiles, previewText, REDACTION_MARGIN } from "./task-files.ts";

/**
 * An artifact's versions and their contents, as the camp sheet and its viewer show them (ADR 037,
 * #1434). Read only. A version's contents are what the hub kept of it when its Attempt changed the
 * file, or, for the latest version only, the file as it is now. A file is served only while it is
 * inside the folders of the hob whose chat or camp it is in, and never when its name marks it as one
 * that may hold secrets. Text is redacted, as a turn's tool output is, and cut to what a preview
 * shows; an image is served as it is, up to what the hub serves.
 */
export class ArtifactContents extends Context.Service<
  ArtifactContents,
  {
    readonly versions: (
      threadId: ThreadId,
      artifactId: RegisteredArtifactId,
    ) => Effect.Effect<ArtifactVersions, ArtifactNotFound>;
    readonly content: (
      threadId: ThreadId,
      artifactId: RegisteredArtifactId,
      version: number,
    ) => Effect.Effect<Uint8Array, ArtifactNotFound | ArtifactContentUnavailable>;
  }
>()("@hobbots/agents/ArtifactContents") {
  static readonly layer = Layer.effect(
    ArtifactContents,
    Effect.gen(function* () {
      const records = yield* RecordRepository;
      const repo = yield* HobbotsRepository;
      const setup = yield* InstallationSettings;
      const folderChecks = yield* FolderChecks;
      const files = yield* HobFiles;
      const store = yield* ActivityStore;
      // Without the hub's redactor, secret shapes are still redacted.
      const redactor = Option.getOrElse(yield* Effect.serviceOption(SecretRedaction), () => makeRedactor());
      const encoder = new TextEncoder();
      const decoder = new TextDecoder();

      const stored = (threadId: ThreadId, artifactId: RegisteredArtifactId) =>
        Effect.flatMap(records.artifactVersions(threadId, artifactId), (found) =>
          Option.match(found, {
            onNone: () => Effect.fail(new ArtifactNotFound({ threadId, artifactId })),
            onSome: Effect.succeed,
          }),
        );

      /** The folders of the hob whose chat or camp it is, now, canonical; none once it is gone. */
      const foldersOf = (threadId: ThreadId) =>
        Effect.gen(function* () {
          const thread = yield* repo.findThread(threadId);
          if (Option.isNone(thread)) return [];
          const agent = yield* repo.findAgent(thread.value.agentId);
          if (Option.isNone(agent)) return [];
          const { approvedFolders } = yield* setup.get;
          return yield* hobFoldersNow(folderChecks, approvedFolders, agent.value.policy);
        });

      /** Text redacted and cut to what a preview shows; anything else as it is. */
      const shown = (locator: string, bytes: Uint8Array) =>
        isImageFile(locator) ? bytes : encoder.encode(previewText(redactor.text(decoder.decode(bytes))));

      /** The latest version of a file, read from where it is now inside `folder`. */
      const fileNow = (artifact: Artifact, folder: string) =>
        Effect.gen(function* () {
          const path = artifact.locator.slice(folder.length).replace(/^\//, "");
          const found = yield* files.look(folder, path);
          if (Option.isNone(found)) return "gone" as const;
          const image = isImageFile(artifact.locator);
          if (image && found.value.size > SERVED_FILE_BYTES) return "too-large" as const;
          // Text is redacted before it is cut, over more than is shown, as the Files tab reads it.
          const bytes = yield* files.read(
            folder,
            path,
            image ? found.value.size : Math.min(found.value.size, PREVIEW_TEXT_BYTES + REDACTION_MARGIN),
          );
          return Option.isNone(bytes) ? ("gone" as const) : shown(artifact.locator, bytes.value);
        });

      /** A file's version: refused outside the hob's folders or by a secret's name, else read. */
      const fileVersion = (threadId: ThreadId, artifact: Artifact, version: StoredVersion, latest: boolean) =>
        Effect.gen(function* () {
          if (isSecretFile(artifact.locator)) return "secret" as const;
          if (!isImageFile(artifact.locator) && previewOf(artifact.locator) === "none") return "no-contents" as const;
          const folder = (yield* foldersOf(threadId)).find((each) => within(artifact.locator, each));
          if (folder === undefined) return "outside-folders" as const;
          if (version.source._tag === "kept") {
            const bytes = yield* store.get(version.source.contentId);
            if (Option.isSome(bytes)) return shown(artifact.locator, bytes.value);
          }
          return latest ? yield* fileNow(artifact, folder) : ("not-kept" as const);
        });

      const content = (threadId: ThreadId, artifactId: RegisteredArtifactId, version: number) =>
        Effect.gen(function* () {
          const { artifact, versions } = yield* stored(threadId, artifactId);
          const asked = versions.find((each) => each.version === version);
          if (asked === undefined) return yield* new ArtifactNotFound({ threadId, artifactId });
          const latest = Math.max(...versions.map((each) => each.version)) === version;
          const served: Uint8Array | ArtifactContentRefusal = isFileLocator(artifact.locator)
            ? yield* fileVersion(threadId, artifact, asked, latest)
            : asked.source._tag === "text"
              ? encoder.encode(previewText(redactor.text(asked.source.text)))
              : "no-contents";
          if (typeof served === "string") {
            return yield* new ArtifactContentUnavailable({ artifactId, version, reason: served });
          }
          return served;
        });

      return ArtifactContents.of({
        versions: (threadId, artifactId) =>
          Effect.map(stored(threadId, artifactId), ({ artifact, versions }) => artifactVersions(artifact, versions)),
        content,
      });
    }),
  );
}

/** Whether `location` is `folder` or inside it, by spelling: both are canonical. */
const within = (location: string, folder: string) => location.startsWith(folder.endsWith("/") ? folder : `${folder}/`);
