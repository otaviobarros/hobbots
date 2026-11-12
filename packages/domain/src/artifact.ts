import { Effect, Schema } from "effect";
import { baseName, extensionOf, isImageFile } from "./activity.ts";
import { Actor, GITHUB_ACTOR, hobActor } from "./actor.ts";
import type { JournaledEvent } from "./events.ts";
import { pullRequestOf } from "./github.ts";
import { type AgentId, ChapterId, type MessageId, ThreadId } from "./ids.ts";
import { defineMachine } from "./machine.ts";
import { isInProgress, type Message } from "./message.ts";
import type { ArtifactRef } from "./quest.ts";
import { Revision } from "./revision.ts";
import type { TaskId } from "./task.ts";

/**
 * The artifacts registry (ADR 037, Records): one row for each thing a hob made or changed in a chat
 * or camp, a doc, page, email, image, code file, pull request or other file, at its latest version.
 * It indexes what Attempts, a Task's results and replies already record and copies none of it: a row
 * holds where the thing is and which record saw it last. Every rule here is pure; the repository
 * runs them in the transaction that journals the records they read.
 */

export const RegisteredArtifactId = Schema.String.pipe(Schema.brand("RegisteredArtifactId"));
export type RegisteredArtifactId = typeof RegisteredArtifactId.Type;

/** What an artifact is, as the camp sheet groups them. */
export const RegisteredArtifactKind = Schema.Literals(["code", "page", "doc", "email", "image", "pr", "file"]);
export type RegisteredArtifactKind = typeof RegisteredArtifactKind.Type;

/** Where an artifact stands with you, held by `ArtifactReviewMachine`. */
export const ArtifactReview = Schema.Literals(["waiting", "reviewed", "dismissed"]);
export type ArtifactReview = typeof ArtifactReview.Type;

/** What you can do with an artifact waiting for you: mark it reviewed, or dismiss it. */
export const ArtifactReviewOutcome = Schema.Literals(["reviewed", "dismissed"]);
export type ArtifactReviewOutcome = typeof ArtifactReviewOutcome.Type;

/**
 * The record that saw an artifact: an Attempt's file changes, a Task's result (a Quest artifact,
 * `ArtifactRef`) or a reply's tool steps, by its id.
 */
export const ArtifactOrigin = Schema.Struct({
  kind: Schema.Literals(["attempt", "task-artifact", "message"]),
  id: Schema.String,
});
export type ArtifactOrigin = typeof ArtifactOrigin.Type;

export class Artifact extends Schema.Class<Artifact>("Artifact")({
  id: RegisteredArtifactId,
  /** The chat or camp it belongs to, and the chapter it was first made in. */
  threadId: ThreadId,
  chapterId: ChapterId,
  kind: RegisteredArtifactKind,
  title: Schema.String,
  /**
   * Where it is, which makes it one artifact in its chat or camp whatever records it: a file's path
   * on the hub, a link's URL, or for a text result, `text:` and the result's id.
   */
  locator: Schema.String,
  /** How many records made or changed it: 1 when one did. */
  latestVersion: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  /** The record that saw its latest version. */
  origin: ArtifactOrigin,
  /** Who made its latest version. */
  actor: Actor,
  createdAt: Schema.String,
  updatedAt: Schema.String,
  /**
   * Where it stands with you. Only `ArtifactReviewMachine` changes it, and code outside reads it
   * through `ArtifactReviews`. Artifacts journaled before it existed decode as waiting.
   */
  review: ArtifactReview.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed("waiting" as const)),
    Schema.withConstructorDefault(Effect.succeed("waiting" as const)),
  ),
  /** When it was reviewed or dismissed, and by whom; null while it waits. */
  reviewedAt: Schema.NullOr(Schema.String).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(null)),
    Schema.withConstructorDefault(Effect.succeed(null)),
  ),
  reviewedBy: Schema.NullOr(Actor).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(null)),
    Schema.withConstructorDefault(Effect.succeed(null)),
  ),
  revision: Revision,
}) {}

/** What can happen to an artifact waiting for you. */
export type ArtifactReviewEvent =
  /** You looked at it and marked it reviewed. */
  | { readonly _tag: "Review"; readonly at: string; readonly by: Actor }
  /** You chose not to review it. */
  | { readonly _tag: "Dismiss"; readonly at: string; readonly by: Actor }
  /** GitHub reported its pull request merged or closed, so nothing is left to review. */
  | { readonly _tag: "PullRequestEnded"; readonly at: string };

/** A change to an artifact's review its state does not allow. */
export class IllegalArtifactReviewTransition extends Schema.TaggedError<IllegalArtifactReviewTransition>()(
  "IllegalArtifactReviewTransition",
  { artifactId: RegisteredArtifactId, from: ArtifactReview, to: ArtifactReview },
) {}

const settled = (artifact: Artifact, review: ArtifactReview, at: string, by: Actor) =>
  new Artifact({ ...artifact, review, reviewedAt: at, reviewedBy: by });

/**
 * An artifact's review (ADR 037, #1422), declared once. Every artifact starts waiting for you; it
 * is reviewed or dismissed once, and only a pull request is reviewed by GitHub ending it.
 */
export const ArtifactReviewMachine = defineMachine<
  ArtifactReview,
  ArtifactReviewEvent,
  Artifact,
  IllegalArtifactReviewTransition
>({
  name: "ArtifactReview",
  states: {
    waiting: "Made or changed by a hob, and not reviewed yet",
    reviewed: "You reviewed it, or GitHub reported its pull request merged or closed",
    dismissed: "You chose not to review it",
  },
  field: "review",
  events: {
    Review: {
      from: ["waiting"],
      to: "reviewed",
      apply: (artifact, e) => settled(artifact, "reviewed", e.at, e.by),
    },
    Dismiss: {
      from: ["waiting"],
      to: "dismissed",
      apply: (artifact, e) => settled(artifact, "dismissed", e.at, e.by),
    },
    // Only a pull request has a pull request to end.
    PullRequestEnded: {
      from: ["waiting"],
      to: "reviewed",
      guard: (artifact) => artifact.kind === "pr",
      apply: (artifact, e) => settled(artifact, "reviewed", e.at, GITHUB_ACTOR),
    },
  },
  illegal: (artifact, _, to) =>
    new IllegalArtifactReviewTransition({ artifactId: artifact.id, from: artifact.review, to }),
});

/** The kinds of artifact you review: what a Quest counts as ready for review. */
const REVIEWABLE: ReadonlySet<RegisteredArtifactKind> = new Set(["pr", "doc", "page", "code"]);

/** `ArtifactReviewMachine` with the questions code outside this module asks of an artifact's review. */
export const ArtifactReviews = {
  ...ArtifactReviewMachine,
  /** Whether it is of a kind you review, and still waits for you. */
  awaitsReview: (artifact: Pick<Artifact, "kind" | "review">): boolean =>
    REVIEWABLE.has(artifact.kind) && artifact.review === "waiting",
};

/** Why a review changed nothing: the artifact is not in the chat or camp, or was settled another way. */
export const ArtifactReviewRefusal = Schema.Literals(["not-found", "settled"]);
export type ArtifactReviewRefusal = typeof ArtifactReviewRefusal.Type;

export class ArtifactReviewRefused extends Schema.TaggedError<ArtifactReviewRefused>()("ArtifactReviewRefused", {
  artifactId: RegisteredArtifactId,
  reason: ArtifactReviewRefusal,
}) {}

/**
 * The pure rule of your review: an artifact waiting for you is reviewed or dismissed; one settled
 * that way already is answered as it is, so the same request again changes nothing; one settled the
 * other way is refused.
 */
export const planReview = (input: {
  readonly id: RegisteredArtifactId;
  readonly artifact: Artifact | null;
  readonly outcome: ArtifactReviewOutcome;
  readonly by: Actor;
  readonly at: string;
}): { readonly artifact: Artifact; readonly changed: boolean } | ArtifactReviewRefused => {
  const { artifact } = input;
  if (artifact === null) return new ArtifactReviewRefused({ artifactId: input.id, reason: "not-found" });
  const event: ArtifactReviewEvent =
    input.outcome === "reviewed"
      ? { _tag: "Review", at: input.at, by: input.by }
      : { _tag: "Dismiss", at: input.at, by: input.by };
  const next = ArtifactReviews.transition(artifact, event);
  if (next instanceof Artifact) return { artifact: next, changed: true };
  return artifact.review === input.outcome
    ? { artifact, changed: false }
    : new ArtifactReviewRefused({ artifactId: input.id, reason: "settled" });
};

/** A pull request artifact after GitHub reported it merged or closed, or null when that changes nothing. */
export const planPullRequestEnded = (artifact: Artifact, at: string): Artifact | null => {
  const next = ArtifactReviews.transition(artifact, { _tag: "PullRequestEnded", at });
  return next instanceof Artifact ? next : null;
};

/**
 * One record's word that it made or changed an artifact, before the registry places it. A sighting
 * from a Task names the Task, whose thread and owner the repository reads; one from a reply names
 * its thread, chapter and author itself.
 */
export interface ArtifactSighting {
  readonly locator: string;
  readonly kind: RegisteredArtifactKind;
  /** The name its record gave it, or null when it gave none, such as a file a step edited. */
  readonly label: string | null;
  /** What it is called when no record named it. */
  readonly fallbackTitle: string;
  readonly origin: ArtifactOrigin;
  readonly from:
    | { readonly _tag: "Task"; readonly taskId: TaskId }
    | {
        readonly _tag: "Message";
        readonly messageId: MessageId;
        readonly threadId: ThreadId;
        readonly chapterId: ChapterId;
        readonly actor: Actor;
      };
}

const CODE_EXTENSIONS: ReadonlySet<string> = new Set([
  "c",
  "cc",
  "cjs",
  "cpp",
  "cs",
  "css",
  "go",
  "h",
  "hpp",
  "java",
  "js",
  "json",
  "jsx",
  "kt",
  "mjs",
  "php",
  "py",
  "rb",
  "rs",
  "scss",
  "sh",
  "sql",
  "svelte",
  "swift",
  "toml",
  "ts",
  "tsx",
  "vue",
  "xml",
  "yaml",
  "yml",
]);
const DOC_EXTENSIONS: ReadonlySet<string> = new Set(["doc", "docx", "md", "mdx", "odt", "pages", "pdf", "rtf", "txt"]);
const PAGE_EXTENSIONS: ReadonlySet<string> = new Set(["htm", "html"]);
const EMAIL_EXTENSIONS: ReadonlySet<string> = new Set(["eml", "msg"]);

/** What a file is, by its name. */
export const fileArtifactKind = (path: string): RegisteredArtifactKind => {
  if (isImageFile(path)) return "image";
  const extension = extensionOf(baseName(path));
  if (EMAIL_EXTENSIONS.has(extension)) return "email";
  if (PAGE_EXTENSIONS.has(extension)) return "page";
  if (DOC_EXTENSIONS.has(extension)) return "doc";
  return CODE_EXTENSIONS.has(extension) ? "code" : "file";
};

/** What a link is: a pull request, or a page. */
export const linkArtifactKind = (url: string): RegisteredArtifactKind => (pullRequestOf(url) === null ? "page" : "pr");

/** A file's path with no `/` at its end, so two records of one file agree. */
const filePath = (path: string): string => {
  // A loop, not a regular expression, so a path of many `/` costs no more than its length.
  let end = path.length;
  while (end > 0 && path[end - 1] === "/") end--;
  return end === 0 ? "/" : path.slice(0, end);
};

/** A Task's result as the registry sees it: a file, a link, or a text kept under its own id. */
const refSighting = (ref: ArtifactRef): ArtifactSighting => {
  const base = { label: ref.label.trim() || null, origin: { kind: "task-artifact", id: ref.id } as const };
  const from = { _tag: "Task", taskId: ref.taskId } as const;
  switch (ref.kind) {
    case "file": {
      const locator = filePath(ref.value);
      return { ...base, locator, kind: fileArtifactKind(locator), fallbackTitle: baseName(locator), from };
    }
    case "link":
      return { ...base, locator: ref.value, kind: linkArtifactKind(ref.value), fallbackTitle: ref.value, from };
    case "text":
      return { ...base, locator: `text:${ref.id}`, kind: "doc", fallbackTitle: "Text result", from };
  }
};

/** The files an Attempt's settled changes left, in its folder: added, edited or moved there, not deleted. */
const changeSightings = (event: Extract<JournaledEvent, { readonly _tag: "FileChangesRecorded" }>) =>
  event.changes.flatMap((change): ReadonlyArray<ArtifactSighting> => {
    if (!change.settled || change.after === null || change.kind === "deleted" || change.kind === "link") return [];
    const locator = filePath(`${event.folder.replace(/\/+$/, "")}/${change.path}`);
    return [
      {
        locator,
        kind: fileArtifactKind(locator),
        label: null,
        fallbackTitle: baseName(locator),
        origin: { kind: "attempt", id: event.attemptId },
        from: { _tag: "Task", taskId: event.taskId },
      },
    ];
  });

/**
 * The files a reply's finished turn wrote with its tool steps: each step that edited files and
 * ended without an error, by the canonical paths the policy decided it on (ADR 014). A reply still
 * being written is read once it ends.
 */
const replySightings = (message: Message): ReadonlyArray<ArtifactSighting> => {
  if (message.role !== "assistant" || isInProgress(message.status) || message.status === "queued") return [];
  if (message.chapterId === null || message.actor === null) return [];
  const from = {
    _tag: "Message",
    messageId: message.id,
    threadId: message.threadId,
    chapterId: message.chapterId,
    actor: message.actor,
  } as const;
  const paths = new Set(
    message.steps.flatMap((step) =>
      step.kind === "tool" && step.state === "done" && step.call?.operation === "edit-files" ? step.call.targets : [],
    ),
  );
  return [...paths].map((path) => {
    const locator = filePath(path);
    return {
      locator,
      kind: fileArtifactKind(locator),
      label: null,
      fallbackTitle: baseName(locator),
      origin: { kind: "message", id: message.id },
      from,
    };
  });
};

/**
 * What a change's events say was made or changed (ADR 037): a Task's results as it completes, an
 * Attempt's settled file changes, and the files a finished reply's steps wrote. A pure rule, run in
 * the transaction that journals the events, as `backpackItemsFor` is.
 */
export const artifactSightings = (events: ReadonlyArray<JournaledEvent>): ReadonlyArray<ArtifactSighting> =>
  events.flatMap((event) => {
    switch (event._tag) {
      case "TaskCompleted":
        return event.artifacts.map(refSighting);
      case "FileChangesRecorded":
        return changeSightings(event);
      case "MessageUpserted":
        return replySightings(event.message);
      default:
        return [];
    }
  });

/** Where a sighting lands, once the repository read it: its chat or camp, chapter and author. */
export interface PlacedSighting {
  readonly sighting: ArtifactSighting;
  readonly threadId: ThreadId;
  readonly chapterId: ChapterId;
  readonly actor: Actor;
}

/** A sighting from a Task, placed in the Task's thread and live chapter, made by the Task's owner. */
export const placedFromTask = (
  sighting: ArtifactSighting,
  task: { readonly threadId: ThreadId; readonly chapterId: ChapterId; readonly ownerId: AgentId },
): PlacedSighting => ({ sighting, threadId: task.threadId, chapterId: task.chapterId, actor: hobActor(task.ownerId) });

/**
 * The registry's row after `placed`, or null when it changes nothing: a record that already saw the
 * artifact never counts twice, so a replayed or repeated event leaves it as it is. A new artifact
 * starts at version 1 in the chapter it was made in, waiting for your review; a later record moves
 * it to its next version, keeping the name a record gave it unless the new one gives another, and
 * keeping its review.
 */
export const registeredArtifact = (input: {
  readonly existing: Artifact | null;
  readonly placed: PlacedSighting;
  /** Whether the record behind the sighting saw this artifact before. */
  readonly seen: boolean;
  readonly id: RegisteredArtifactId;
  readonly at: string;
}): Artifact | null => {
  const { existing, placed } = input;
  if (input.seen) return null;
  const { sighting } = placed;
  if (existing === null) {
    return new Artifact({
      id: input.id,
      threadId: placed.threadId,
      chapterId: placed.chapterId,
      kind: sighting.kind,
      title: sighting.label ?? sighting.fallbackTitle,
      locator: sighting.locator,
      latestVersion: 1,
      origin: sighting.origin,
      actor: placed.actor,
      createdAt: input.at,
      updatedAt: input.at,
    });
  }
  return new Artifact({
    ...existing,
    kind: sighting.kind,
    title: sighting.label ?? existing.title,
    latestVersion: existing.latestVersion + 1,
    origin: sighting.origin,
    actor: placed.actor,
    updatedAt: input.at,
  });
};
