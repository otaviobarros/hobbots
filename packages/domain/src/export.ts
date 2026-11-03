import { Schema } from "effect";
import { CommandState, FileChangeKind } from "./activity.ts";
import { AgentStatus, Effort, RuntimeKind } from "./agent.ts";
import { AgentId, MessageId, ThreadId } from "./ids.ts";
import { MessageRole, MessageStatus, ReplyStepState, ReplyUsage } from "./message.ts";
import { ArtifactId, ArtifactKind, QuestId, QuestionId, QuestionState, QuestState } from "./quest.ts";
import { RoleId } from "./roles.ts";
import { AttemptId, AttemptState, TaskId, TaskState } from "./task.ts";

/**
 * An export of ADR 026: your conversations and work history as a folder you can read without
 * Hobbots. It is not a backup: it cannot be restored, it holds only what you chose, and every
 * string in it is redacted. `export.json` is the `HobbotsExport` below, encoded from this schema,
 * so a field that is not named here never reaches it.
 */

/** What an export covers: one thread, one hob, or everything. */
export const ExportScope = Schema.Union([
  Schema.TaggedStruct("Thread", { threadId: ThreadId }),
  Schema.TaggedStruct("Hob", { agentId: AgentId }),
  Schema.TaggedStruct("Everything", {}),
]);
export type ExportScope = typeof ExportScope.Type;

export const EXPORT_FORMAT = "hobbots.export";
export const EXPORT_VERSION = 1;

/** The most of one file an export copies, and of all the files it copies together (ADR 026). */
export const EXPORT_FILE_BYTES = 100 * 1024 * 1024;
export const EXPORT_TOTAL_BYTES = 1024 * 1024 * 1024;

/** A hob as a record: who it is and what it thinks with. Its instructions and policy are not exported. */
export const ExportedHob = Schema.Struct({
  id: AgentId,
  name: Schema.String,
  role: Schema.NullOr(RoleId),
  roleTitle: Schema.String,
  runtime: RuntimeKind,
  model: Schema.NullOr(Schema.String),
  effort: Schema.NullOr(Effort),
  status: AgentStatus,
});
export type ExportedHob = typeof ExportedHob.Type;

/** A reply's step, as one line: its label, how it ended and the tool it called. Its output is not exported. */
export const ExportedStep = Schema.Struct({
  label: Schema.String,
  state: ReplyStepState,
  tool: Schema.NullOr(Schema.String),
});
export type ExportedStep = typeof ExportedStep.Type;

export const ExportedMessage = Schema.Struct({
  id: MessageId,
  role: MessageRole,
  /** The hob that wrote a reply; null for your own messages. */
  authorId: Schema.NullOr(AgentId),
  content: Schema.String,
  status: MessageStatus,
  error: Schema.NullOr(Schema.String),
  runtime: Schema.NullOr(RuntimeKind),
  model: Schema.NullOr(Schema.String),
  /** As the reply's runtime reported it (#398). */
  usage: Schema.NullOr(ReplyUsage),
  steps: Schema.Array(ExportedStep),
  createdAt: Schema.String,
});
export type ExportedMessage = typeof ExportedMessage.Type;

export const ExportedThread = Schema.Struct({
  id: ThreadId,
  agentId: AgentId,
  title: Schema.String,
  createdAt: Schema.String,
  updatedAt: Schema.String,
  archivedAt: Schema.NullOr(Schema.String),
  /** Its Markdown file, relative to the export folder. */
  file: Schema.String,
  messages: Schema.Array(ExportedMessage),
});
export type ExportedThread = typeof ExportedThread.Type;

/**
 * Why a file artifact was not copied. `gone`: it is no longer a regular file. `outside-folders`:
 * it is not in the hob's folders now. `secret`: its name marks it as one that may hold secrets.
 * `holds-secret`: it is not text the redactor can rewrite, and it holds something the redactor
 * recognizes as a secret. `too-large`: it is over the most one file may be. `export-full`: the
 * export already holds as much as it may.
 */
export const ArtifactNotCopied = Schema.Literals([
  "gone",
  "outside-folders",
  "secret",
  "holds-secret",
  "too-large",
  "export-full",
]);
export type ArtifactNotCopied = typeof ArtifactNotCopied.Type;

export const ExportedArtifact = Schema.Struct({
  id: ArtifactId,
  kind: ArtifactKind,
  label: Schema.String,
  /** The path, URL or text the Task gave. */
  value: Schema.String,
  /** Where a copied file is, relative to the export folder. */
  copiedTo: Schema.NullOr(Schema.String),
  /** Why a file artifact was not copied; null for a copied file, a link or text. */
  notCopied: Schema.NullOr(ArtifactNotCopied),
});
export type ExportedArtifact = typeof ExportedArtifact.Type;

/** A command the Workbench recorded. Its output and log belong in a backup, not here. */
export const ExportedCommand = Schema.Struct({
  command: Schema.String,
  folder: Schema.String,
  state: CommandState,
  exitCode: Schema.NullOr(Schema.Int),
  startedAt: Schema.String,
  endedAt: Schema.NullOr(Schema.String),
});
export type ExportedCommand = typeof ExportedCommand.Type;

/** A file change the Workbench recorded, without its contents. */
export const ExportedChange = Schema.Struct({
  folder: Schema.String,
  path: Schema.String,
  kind: FileChangeKind,
  movedFrom: Schema.NullOr(Schema.String),
});
export type ExportedChange = typeof ExportedChange.Type;

export const ExportedAttempt = Schema.Struct({
  id: AttemptId,
  number: Schema.Int,
  agentId: AgentId,
  runtime: RuntimeKind,
  state: AttemptState,
  outcome: Schema.NullOr(Schema.String),
  startedAt: Schema.String,
  endedAt: Schema.NullOr(Schema.String),
  commands: Schema.Array(ExportedCommand),
  changes: Schema.Array(ExportedChange),
});
export type ExportedAttempt = typeof ExportedAttempt.Type;

export const ExportedQuestion = Schema.Struct({
  id: QuestionId,
  askerId: AgentId,
  text: Schema.String,
  state: QuestionState,
  answer: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  answeredAt: Schema.NullOr(Schema.String),
});
export type ExportedQuestion = typeof ExportedQuestion.Type;

export const ExportedNote = Schema.Struct({
  text: Schema.String,
  createdAt: Schema.String,
});
export type ExportedNote = typeof ExportedNote.Type;

/**
 * `full`: everything the export holds about a Task. `summary`: its title and state only, for
 * another hob's Task in a hob's export (ADR 026).
 */
export const ExportedDetail = Schema.Literals(["full", "summary"]);
export type ExportedDetail = typeof ExportedDetail.Type;

export const ExportedTask = Schema.Struct({
  id: TaskId,
  parentId: Schema.NullOr(TaskId),
  ownerId: AgentId,
  title: Schema.String,
  state: TaskState,
  detail: ExportedDetail,
  createdAt: Schema.String,
  updatedAt: Schema.String,
  /** The rest is empty or null for a summary. */
  brief: Schema.NullOr(Schema.String),
  result: Schema.NullOr(Schema.String),
  artifacts: Schema.Array(ExportedArtifact),
  questions: Schema.Array(ExportedQuestion),
  notes: Schema.Array(ExportedNote),
  attempts: Schema.Array(ExportedAttempt),
});
export type ExportedTask = typeof ExportedTask.Type;

/** A Quest's goal is its title; its acceptance is part of its Task's detail, so a summary has none. */
export const ExportedQuest = Schema.Struct({
  id: QuestId,
  taskId: TaskId,
  leadId: AgentId,
  goal: Schema.String,
  detail: ExportedDetail,
  acceptance: Schema.Array(Schema.String),
  state: QuestState,
  createdAt: Schema.String,
  endedAt: Schema.NullOr(Schema.String),
});
export type ExportedQuest = typeof ExportedQuest.Type;

/** A Task you asked for and everything under it: a Quest once it brought in other hobs. */
export const ExportedTree = Schema.Struct({
  rootTaskId: TaskId,
  threadId: Schema.NullOr(ThreadId),
  title: Schema.String,
  /** Its Markdown file, relative to the export folder. */
  file: Schema.String,
  quests: Schema.Array(ExportedQuest),
  /** The top Task first, then the rest depth first, oldest first among siblings. */
  tasks: Schema.Array(ExportedTask),
});
export type ExportedTree = typeof ExportedTree.Type;

export const HobbotsExport = Schema.Struct({
  format: Schema.Literal(EXPORT_FORMAT),
  version: Schema.Literal(EXPORT_VERSION),
  exportedAt: Schema.String,
  hobbotsVersion: Schema.String,
  scope: ExportScope,
  hobs: Schema.Array(ExportedHob),
  threads: Schema.Array(ExportedThread),
  quests: Schema.Array(ExportedTree),
});
export type HobbotsExport = typeof HobbotsExport.Type;

const UNSAFE_NAME = /[\p{Cc}/\\:*?"<>|]+/gu;
const NAME_MAX = 80;

/**
 * A title as one part of a file name on any system: no separators, control or reserved characters,
 * no leading dots, and at most 80 characters. An empty one becomes `fallback`.
 */
export const safeFileName = (title: string, fallback: string): string => {
  const cleaned = title.replace(UNSAFE_NAME, " ").replace(/\s+/g, " ").trim().replace(/^\.+/, "").trim();
  const cut = cleaned.length > NAME_MAX ? cleaned.slice(0, NAME_MAX).trimEnd() : cleaned;
  return cut === "" ? fallback : cut;
};

/** `name`, or `name (2)`, `name (3)` and on, whichever `taken` does not hold yet; the pick is added to it. */
export const uniqueName = (taken: Set<string>, name: string, extension = ""): string => {
  let pick = `${name}${extension}`;
  for (let count = 2; taken.has(pick.toLowerCase()); count += 1) pick = `${name} (${count})${extension}`;
  taken.add(pick.toLowerCase());
  return pick;
};

/** The first line of a Task's brief: what the Quest tab shows as its title. */
export const taskTitleOf = (brief: string): string => brief.split("\n", 1)[0]?.trim() ?? "";
