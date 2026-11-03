import type {
  AgentId,
  ArtifactNotCopied,
  ExportedArtifact,
  ExportedAttempt,
  ExportedMessage,
  ExportedTask,
  ExportedThread,
  ExportedTree,
  HobbotsExport,
} from "@hobbots/domain";
import { EXPORT_FORMAT, EXPORT_VERSION } from "@hobbots/domain";

/**
 * The Markdown files of an export (ADR 026), from its redacted records. The export is a document
 * the hub writes for you to keep, so its words are written here, in English, for now.
 */

/** Who someone is, by id, for the files' bylines. */
export type ExportNames = ReadonlyMap<AgentId, string>;

/** `2026-11-02 10:00 UTC` from an ISO 8601 time. */
const when = (iso: string): string => `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;

const nameOf = (names: ExportNames, id: AgentId): string => names.get(id) ?? "A hob no longer on this hub";

/** Text as a Markdown quote block, so its own headings and lists stay inside it. */
const quoted = (text: string): string =>
  text
    .split("\n")
    .map((line) => (line === "" ? ">" : `> ${line}`))
    .join("\n");

/** Inline code that holds any text, backticks included. */
const code = (text: string): string => {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((run) => run[0].length));
  const fence = "`".repeat(longest + 1);
  return longest === 0 ? `${fence}${text}${fence}` : `${fence} ${text} ${fence}`;
};

const messageBlock = (message: ExportedMessage, names: ExportNames): string => {
  const author = message.authorId === null ? "You" : nameOf(names, message.authorId);
  const lines = [
    `**${author}** · ${when(message.createdAt)}`,
    "",
    message.content.trim() === "" ? "_No text._" : message.content,
  ];
  const steps = message.steps.map((step) => `- ${step.label}: ${step.state}`);
  if (steps.length > 0) lines.push("", ...steps);
  if (message.error !== null) lines.push("", `_The reply ended early: ${message.error}_`);
  else if (message.status !== "complete") lines.push("", `_This message is ${message.status}._`);
  return lines.join("\n");
};

/** One thread: who wrote each message and when, the replies, and each tool step as one line with its outcome. */
export const threadMarkdown = (thread: ExportedThread, names: ExportNames): string => {
  const about = [
    nameOf(names, thread.agentId),
    `started ${when(thread.createdAt)}`,
    ...(thread.archivedAt === null ? [] : [`archived ${when(thread.archivedAt)}`]),
  ].join(" · ");
  const body = thread.messages.length === 0 ? ["_No messages._"] : thread.messages.map((m) => messageBlock(m, names));
  return [`# ${thread.title}`, "", about, "", "---", "", body.join("\n\n---\n\n"), ""].join("\n");
};

const NOT_COPIED: Record<ArtifactNotCopied, string> = {
  gone: "it is no longer there",
  "outside-folders": "it is not in the hob's folders now",
  secret: "its name marks it as a file that may hold secrets",
  "holds-secret": "it holds what looks like a secret, and it is not text that could be redacted",
  "too-large": "it is larger than 100 MiB",
  "export-full": "the export already holds 1 GiB of files",
};

/** A relative path as a link target: each segment encoded, so `#`, `?`, spaces and brackets stay part of the name. */
const linkTarget = (path: string): string =>
  path
    .split("/")
    .map((segment) =>
      encodeURIComponent(segment).replace(/[()]/g, (paren) => `%${paren.charCodeAt(0).toString(16).toUpperCase()}`),
    )
    .join("/");

/** Text that Markdown shows as it is inside a link's brackets. */
const linkText = (text: string): string => text.replace(/[\\[\]*_`<>]/g, (character) => `\\${character}`);

const artifactLine = (artifact: ExportedArtifact): string => {
  switch (artifact.kind) {
    case "link":
      return `- Link “${artifact.label}”: ${artifact.value}`;
    case "text":
      return `- Text “${artifact.label}”:\n\n${quoted(artifact.value)}\n`;
    default:
      return artifact.copiedTo !== null
        ? `- File “${artifact.label}”: [${linkText(artifact.copiedTo)}](../${linkTarget(artifact.copiedTo)}), from ${code(artifact.value)}`
        : `- File “${artifact.label}”: ${code(artifact.value)}, not copied because ${NOT_COPIED[artifact.notCopied ?? "gone"]}`;
  }
};

const attemptLines = (attempt: ExportedAttempt, names: ExportNames): ReadonlyArray<string> => [
  `- Attempt ${attempt.number} by ${nameOf(names, attempt.agentId)} on ${attempt.runtime}, ${attempt.state}, ${when(attempt.startedAt)}${attempt.outcome === null ? "" : `: ${attempt.outcome}`}`,
  ...attempt.commands.map(
    (command) =>
      `  - Ran ${code(command.command)} in ${code(command.folder)}: ${command.state}${command.exitCode === null ? "" : `, exit ${command.exitCode}`}`,
  ),
  ...attempt.changes.map(
    (change) =>
      `  - ${change.kind[0]?.toUpperCase()}${change.kind.slice(1)} ${code(change.path)} in ${code(change.folder)}${change.movedFrom === null ? "" : `, from ${code(change.movedFrom)}`}`,
  ),
];

/** A section of a Task's details, left out when it has nothing. */
const section = (title: string, lines: ReadonlyArray<string>): ReadonlyArray<string> =>
  lines.length === 0 ? [] : ["", `**${title}**`, "", ...lines];

const fullTask = (task: ExportedTask, names: ExportNames): ReadonlyArray<string> => [
  ...(task.brief === null ? [] : ["", quoted(task.brief)]),
  ...(task.result === null ? [] : ["", `**Result:** ${task.result}`]),
  ...section("Artifacts", task.artifacts.map(artifactLine)),
  ...section(
    "Questions",
    task.questions.map(
      (question) =>
        `- ${nameOf(names, question.askerId)} asked: ${question.text}${question.answer === null ? ` (${question.state})` : `\n  Answer: ${question.answer}`}`,
    ),
  ),
  ...section(
    "Notes",
    task.notes.map((note) => `- ${when(note.createdAt)}: ${note.text}`),
  ),
  ...section(
    "Attempts",
    task.attempts.flatMap((attempt) => attemptLines(attempt, names)),
  ),
];

const taskBlock = (task: ExportedTask, tree: ExportedTree, names: ExportNames): string => {
  const parent = tree.tasks.find((each) => each.id === task.parentId);
  const about = [
    nameOf(names, task.ownerId),
    task.state,
    ...(parent === undefined ? [] : [`part of “${parent.title}”`]),
  ].join(" · ");
  const details =
    task.detail === "full"
      ? fullTask(task, names)
      : ["", "_Another hob's Task: only its title and state are exported._"];
  return [`### ${task.title === "" ? "Untitled Task" : task.title}`, "", about, ...details].join("\n");
};

/** One Task tree as a Quest: each Task's hob, state, result, artifacts, questions, notes and Attempts. */
export const treeMarkdown = (tree: ExportedTree, names: ExportNames): string => {
  const top = tree.tasks[0];
  const quests = tree.quests.flatMap((quest) => [
    `## Quest: ${quest.goal}`,
    "",
    `Led by ${nameOf(names, quest.leadId)} · ${quest.state} · started ${when(quest.createdAt)}`,
    ...(quest.detail === "summary"
      ? ["", "_Another hob's Quest: only its goal and state are exported._"]
      : quest.acceptance.length === 0
        ? []
        : ["", "Done when:", "", ...quest.acceptance.map((line) => `- ${line}`)]),
    "",
  ]);
  return [
    `# ${tree.title}`,
    "",
    top === undefined ? "" : `Asked of ${nameOf(names, top.ownerId)} · ${when(top.createdAt)} · ${top.state}`,
    "",
    ...quests,
    "## Tasks",
    "",
    tree.tasks.map((task) => taskBlock(task, tree, names)).join("\n\n"),
    "",
  ].join("\n");
};

/** What an export holds, in a sentence. */
const whatOf = (data: HobbotsExport, names: ExportNames): string => {
  switch (data.scope._tag) {
    case "Thread":
      return `The thread “${data.threads[0]?.title ?? ""}”`;
    case "Hob":
      return `${nameOf(names, data.scope.agentId)}'s threads, the Quests it led and the Tasks it worked on`;
    default:
      return "Every hob's threads, Quests and Tasks";
  }
};

/** The README at the top of an export: what it holds, when and by which Hobbots, and that redaction is best effort. */
export const readmeMarkdown = (data: HobbotsExport, names: ExportNames, files: number): string =>
  [
    "# Hobbots export",
    "",
    `${whatOf(data, names)}, exported ${when(data.exportedAt)} by Hobbots ${data.hobbotsVersion}.`,
    "",
    `- \`threads/\`: ${data.threads.length} threads, one Markdown file each.`,
    `- \`quests/\`: ${data.quests.length} Quests and Tasks, one Markdown file for each Task you asked for.`,
    `- \`files/\`: ${files} files the Tasks made, copied from the hobs' folders.`,
    `- \`export.json\`: all of the above as data, format \`${EXPORT_FORMAT}\` version ${EXPORT_VERSION}, with Hobbots' own IDs.`,
    "",
    "## Redaction",
    "",
    "Every piece of text in this export went through Hobbots' redactor, your own messages included: secrets it knows by value and anything shaped like a key or token are replaced with `[redacted: …]`. Redaction is best effort, and a secret it cannot recognize still passes through.",
    "",
    "Text files in `files/` went through the redactor too. Any other file is copied as it is only when the redactor found nothing in it, and is listed and not copied otherwise. A file whose name marks it as one that may hold secrets, such as `.env`, is listed and not copied.",
    "",
    "## What is not here",
    "",
    "This export holds no keys, tokens, devices or sign-ins, and it cannot be restored into Hobbots. A backup is what brings a hub back.",
    "",
  ].join("\n");
