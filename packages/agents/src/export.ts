import { AgentNotFound, type ExportFailed, type ExportResult, type InvalidFolder, ThreadNotFound } from "@hobbots/api";
import {
  type Agent,
  type AgentId,
  type ArtifactNotCopied,
  type ArtifactRef,
  EXPORT_FORMAT,
  EXPORT_VERSION,
  type ExportedArtifact,
  type ExportedAttempt,
  type ExportedHob,
  type ExportedMemory,
  type ExportedMemoryPage,
  type ExportedMessage,
  type ExportedQuest,
  type ExportedTask,
  type ExportedThread,
  type ExportedTree,
  type ExportScope,
  HobbotsExport,
  isSecretFile,
  type MemoryScope,
  type Message,
  type Quest,
  safeFileName,
  type Task,
  type TaskTree,
  type Thread,
  taskTitleOf,
  uniqueName,
} from "@hobbots/domain";
import { Context, DateTime, Effect, Layer, Option, Schema } from "effect";
import { ActivityRepository } from "./activity.ts";
import { SaveDestinations } from "./destinations.ts";
import { EXPORT_LIMITS, type ExportLimits, exportedContents, overLimits } from "./export-files.ts";
import { type ExportNames, readmeMarkdown, threadMarkdown, treeMarkdown } from "./export-markdown.ts";
import { MemoryStore } from "./memory.ts";
import { hobFoldersNow } from "./permissions.ts";
import { FolderChecks, InstallationSettings } from "./ports.ts";
import { HobbotsRepository } from "./repository.ts";
import { makeRedactor, SecretRedaction } from "./secrets.ts";
import { HobFiles } from "./task-files.ts";
import { TaskRepository } from "./tasks.ts";

/**
 * Exports of ADR 026: one thread, one hob or everything, as a folder of Markdown and versioned
 * JSON you can read without Hobbots. Every string goes through the hub's redactor. An export reads
 * hobs, threads, Tasks and the Workbench's records, and the files Tasks made from the hob's folders;
 * it never reads the keychain, the runtimes folder or any device record.
 */

export interface ExportFoldersShape {
  /** Makes a new, empty folder `name` inside `parent`, readable only by the hub's user, and answers its path. */
  readonly create: (parent: string, name: string) => Effect.Effect<string, ExportFailed>;
  /** Writes `contents` at `path` inside `folder`, a relative path whose parent folders it makes. */
  readonly write: (folder: string, path: string, contents: string | Uint8Array) => Effect.Effect<void, ExportFailed>;
  /** Deletes a folder `create` made, with what was written in it. */
  readonly remove: (folder: string) => Effect.Effect<void>;
}

/** Where exports are written, on the hub. */
export class ExportFolders extends Context.Service<ExportFolders, ExportFoldersShape>()(
  "@hobbots/agents/ExportFolders",
) {}

/** What a scope reads from the hub's records, before anything is redacted. */
interface Gathered {
  /** Each hob the export names, so its records and bylines can name it. */
  readonly hobs: ReadonlyArray<Agent>;
  readonly threads: ReadonlyArray<Thread>;
  readonly trees: ReadonlyArray<TaskTree>;
  /** Whether a Task is exported in full, or as its title and state only. */
  readonly full: (task: Task) => boolean;
}

const exportedHob = (agent: Agent): ExportedHob => ({
  id: agent.id,
  name: agent.name,
  role: agent.role,
  roleTitle: agent.roleTitle,
  runtime: agent.runtime,
  model: agent.model,
  effort: agent.effort,
  status: agent.status,
});

const exportedMessage = (message: Message, agentId: AgentId): ExportedMessage => ({
  id: message.id,
  role: message.role,
  authorId: message.role === "assistant" ? agentId : null,
  content: message.content,
  status: message.status,
  error: message.error,
  runtime: message.runtime,
  model: message.model,
  usage: message.usage,
  steps: message.steps
    .filter((step) => step.kind === "tool")
    .map((step) => ({ label: step.label, state: step.state, tool: step.call?.tool ?? null })),
  createdAt: message.createdAt,
});

const exportedArtifact = (artifact: ArtifactRef): ExportedArtifact => ({
  id: artifact.id,
  kind: artifact.kind,
  label: artifact.label,
  value: artifact.value,
  copiedTo: null,
  notCopied: null,
});

/** The tree's Tasks with the top one first, then each Task's children depth first, oldest first. */
/** A Quest, its acceptance only when its Task is exported in full. */
const exportedQuest = (quest: Quest, full: boolean): ExportedQuest => ({
  id: quest.id,
  taskId: quest.taskId,
  leadId: quest.leadId,
  goal: quest.goal,
  detail: full ? "full" : "summary",
  acceptance: full ? quest.acceptance : [],
  state: quest.state,
  createdAt: quest.createdAt,
  endedAt: quest.endedAt,
});

const depthFirst = (tasks: ReadonlyArray<Task>): ReadonlyArray<Task> => {
  const top = tasks[0];
  if (top === undefined) return [];
  const children = new Map<string, Array<Task>>();
  for (const task of tasks.slice(1)) {
    const siblings = children.get(task.parentId ?? "") ?? [];
    siblings.push(task);
    children.set(task.parentId ?? "", siblings);
  }
  const visit = (task: Task): ReadonlyArray<Task> => [task, ...(children.get(task.id) ?? []).flatMap(visit)];
  return visit(top);
};

const summaryTask = (task: Task): ExportedTask => ({
  id: task.id,
  parentId: task.parentId,
  ownerId: task.ownerId,
  title: taskTitleOf(task.brief),
  state: task.state,
  detail: "summary",
  createdAt: task.createdAt,
  updatedAt: task.updatedAt,
  brief: null,
  result: null,
  artifacts: [],
  questions: [],
  notes: [],
  attempts: [],
});

const fullTask = (task: Task, tree: TaskTree, attempts: ReadonlyArray<ExportedAttempt>): ExportedTask => ({
  ...summaryTask(task),
  detail: "full",
  brief: task.brief,
  result: task.result?.summary ?? null,
  artifacts: tree.artifacts.filter((artifact) => artifact.taskId === task.id).map(exportedArtifact),
  questions: tree.questions
    .filter((question) => question.taskId === task.id)
    .map((question) => ({
      id: question.id,
      askerId: question.askerId,
      text: question.text,
      state: question.state,
      answer: question.answer,
      createdAt: question.createdAt,
      answeredAt: question.answeredAt,
    })),
  notes: tree.notes
    .filter((note) => note.taskId === task.id)
    .map((note) => ({ text: note.text, createdAt: note.createdAt })),
  attempts,
});

/** Who a file artifact's bytes come from: the Task's owner, and where the Task named the file. */
interface FileSource {
  readonly ownerId: AgentId;
  readonly value: string;
}

/** Before any page was written: the pages changed since then are every page a scope holds. */
const MEMORY_EPOCH = "1970-01-01T00:00:00.000Z";

/** Memory as an export reads it: each page's record and, at the same index, its Markdown. */
interface GatheredMemory {
  readonly memory: ExportedMemory;
  readonly markdown: ReadonlyArray<string>;
}

const NO_MEMORY: GatheredMemory = { memory: { state: "none", pages: [] }, markdown: [] };

/** Everyone's memory first, then each hob's, then each project's, each by its folder's name. */
const SCOPE_ORDER: Record<MemoryScope["_tag"], number> = { Everyone: 0, Hob: 1, Project: 2 };

/** The folder of a scope's pages in an export: `memory/everyone`, `memory/hobs/<name>`, `memory/projects/<identity>`. */
const memoryFolderOf = (scope: MemoryScope, hobs: ReadonlyArray<Agent>): string => {
  switch (scope._tag) {
    case "Everyone":
      return "memory/everyone";
    case "Hob": {
      const name = hobs.find((hob) => hob.id === scope.agentId)?.name ?? scope.agentId;
      return `memory/hobs/${safeFileName(name, "hob")}`;
    }
    case "Project":
      return `memory/projects/${safeFileName(scope.identity, "project")}`;
  }
};

/** The name of the export's folder, from its redacted records: `Hobbots export <what> <date>`. */
const folderName = (data: HobbotsExport): string => {
  const date = data.exportedAt.slice(0, 10);
  const { scope } = data;
  switch (scope._tag) {
    case "Thread":
      return `Hobbots export ${safeFileName(data.threads[0]?.title ?? "", "thread")} ${date}`;
    case "Hob":
      return `Hobbots export ${safeFileName(data.hobs.find((hob) => hob.id === scope.agentId)?.name ?? "", "hob")} ${date}`;
    default:
      return `Hobbots export everything ${date}`;
  }
};

const encodeExport = Schema.encodeSync(HobbotsExport);

export class DataExport extends Context.Service<
  DataExport,
  {
    /** Writes the scope's export in a new folder inside `destination`, and answers where and how much. */
    readonly run: (
      scope: ExportScope,
      destination: string,
    ) => Effect.Effect<ExportResult, InvalidFolder | AgentNotFound | ThreadNotFound | ExportFailed>;
  }
>()("@hobbots/agents/DataExport") {
  /** `version` is the hub's own, which the export names. `limits` are ADR 026's unless a test sets smaller ones. */
  static readonly layer = (version: string, limits: ExportLimits = EXPORT_LIMITS) =>
    Layer.effect(
      DataExport,
      Effect.gen(function* () {
        const repo = yield* HobbotsRepository;
        const tasks = yield* TaskRepository;
        const activities = yield* ActivityRepository;
        const destinations = yield* SaveDestinations;
        const folders = yield* ExportFolders;
        const files = yield* HobFiles;
        const folderChecks = yield* FolderChecks;
        const setup = yield* InstallationSettings;
        // A hub without memory exports none.
        const memoryStore = yield* Effect.serviceOption(MemoryStore);
        // Without the hub's redactor, secret shapes are still redacted.
        const redactor = Option.getOrElse(yield* Effect.serviceOption(SecretRedaction), () => makeRedactor());

        const allHobs = repo.listAgentsWithStatus(["active", "paused", "retired"]);
        const threadsOf = (agentId: AgentId) =>
          Effect.map(Effect.all([repo.listThreads(agentId), repo.listArchivedThreads(agentId)]), ([live, archived]) => [
            ...live,
            ...archived,
          ]);
        const allThreads = (hobs: ReadonlyArray<Agent>) =>
          Effect.map(
            Effect.forEach(hobs, (hob) => threadsOf(hob.id)),
            (each) => each.flat(),
          );
        /** Each tree started in the threads, once, oldest first within each thread. */
        const treesOf = (threads: ReadonlyArray<Thread>) =>
          Effect.map(
            Effect.forEach(threads, (thread) => tasks.readThreadTrees(thread.id)),
            (each) => {
              const seen = new Set<string>();
              return each.flat().filter((tree) => {
                const top = tree.tasks[0];
                if (top === undefined || seen.has(top.id)) return false;
                seen.add(top.id);
                return true;
              });
            },
          );

        const gather = (scope: ExportScope) =>
          Effect.gen(function* () {
            const hobs = yield* allHobs;
            switch (scope._tag) {
              case "Thread": {
                const thread = yield* repo.findThread(scope.threadId);
                if (Option.isNone(thread)) return yield* new ThreadNotFound({ threadId: scope.threadId });
                const trees = yield* treesOf([thread.value]);
                return { hobs, threads: [thread.value], trees, full: () => true } satisfies Gathered;
              }
              case "Hob": {
                if (!hobs.some((hob) => hob.id === scope.agentId)) {
                  return yield* new AgentNotFound({ agentId: scope.agentId });
                }
                // Its own threads, and every tree it worked in, wherever the tree started (ADR 026).
                const trees = (yield* treesOf(yield* allThreads(hobs))).filter((tree) =>
                  tree.tasks.some((task) => task.ownerId === scope.agentId),
                );
                const threads = yield* threadsOf(scope.agentId);
                return {
                  hobs,
                  threads,
                  trees,
                  full: (task: Task) => task.ownerId === scope.agentId,
                } satisfies Gathered;
              }
              default: {
                const threads = yield* allThreads(hobs);
                return { hobs, threads, trees: yield* treesOf(threads), full: () => true } satisfies Gathered;
              }
            }
          });

        const attemptsOf = (task: Task, tree: TaskTree) =>
          Effect.forEach(
            tree.attempts.filter((attempt) => attempt.taskId === task.id),
            (attempt) =>
              Effect.map(
                activities.read(attempt.id),
                (activity): ExportedAttempt => ({
                  id: attempt.id,
                  number: attempt.number,
                  agentId: attempt.agentId,
                  runtime: attempt.runtime,
                  state: attempt.state,
                  outcome: attempt.outcome,
                  startedAt: attempt.startedAt,
                  endedAt: attempt.endedAt,
                  commands: Option.match(activity, {
                    onNone: () => [],
                    onSome: ({ commands }) =>
                      commands.map((command) => ({
                        command: command.command,
                        folder: command.folder,
                        state: command.state,
                        exitCode: command.exitCode,
                        startedAt: command.startedAt,
                        endedAt: command.endedAt,
                      })),
                  }),
                  changes: Option.match(activity, {
                    onNone: () => [],
                    onSome: ({ changes }) =>
                      changes.map((change) => ({
                        folder: change.folder,
                        path: change.path,
                        kind: change.kind,
                        movedFrom: change.movedFrom,
                      })),
                  }),
                }),
              ),
          );

        const treeRecord = (tree: TaskTree, full: Gathered["full"]) =>
          Effect.gen(function* () {
            const ordered = depthFirst(tree.tasks);
            const exported = yield* Effect.forEach(ordered, (task) =>
              full(task)
                ? Effect.map(attemptsOf(task, tree), (attempts) => fullTask(task, tree, attempts))
                : Effect.succeed(summaryTask(task)),
            );
            const [top] = ordered;
            // `treesOf` keeps only trees that hold a Task.
            if (top === undefined) return yield* Effect.die("A Task tree with no Task");
            const quest = tree.quests.find((each) => each.taskId === top.id);
            return {
              rootTaskId: top.id,
              threadId: top.threadId,
              title: quest?.goal ?? taskTitleOf(top.brief),
              file: "",
              quests: tree.quests.map((each) => {
                const owned = tree.tasks.find((task) => task.id === each.taskId);
                return exportedQuest(each, owned !== undefined && full(owned));
              }),
              tasks: exported,
            } satisfies ExportedTree;
          });

        /**
         * Each memory page the scope covers, as you read it (ADR 028): every scope for everything, the
         * hob's own memory for a hob, none for a thread. Memory that does not answer leaves the rest
         * of the export as it is, and the README says so.
         */
        const gatherMemory = (scope: ExportScope, hobs: ReadonlyArray<Agent>) =>
          Effect.gen(function* () {
            if (Option.isNone(memoryStore) || scope._tag === "Thread") return NO_MEMORY;
            const store = memoryStore.value;
            const you = { _tag: "You" } as const;
            const held = yield* store.scopes(you);
            const wanted = held
              .filter((each) => scope._tag === "Everything" || (each._tag === "Hob" && each.agentId === scope.agentId))
              .map((each) => ({ scope: each, folder: memoryFolderOf(each, hobs) }))
              .sort(
                (a, b) => SCOPE_ORDER[a.scope._tag] - SCOPE_ORDER[b.scope._tag] || a.folder.localeCompare(b.folder),
              );
            const taken = new Set<string>();
            const pages: Array<ExportedMemoryPage> = [];
            const markdown: Array<string> = [];
            for (const { scope: each, folder } of wanted) {
              // Two hobs of one name, or two projects that read alike, each keep a folder of their own.
              const unique = uniqueName(taken, folder);
              // Every page, read through to the end: an export never stops at a count.
              const summaries = [...(yield* store.changes(you, each, MEMORY_EPOCH))].sort((a, b) =>
                a.path.localeCompare(b.path),
              );
              for (const summary of summaries) {
                const page = yield* store.page(you, each, summary.path);
                if (page === null) continue;
                pages.push({
                  scope: each,
                  path: page.path,
                  title: summary.title,
                  pinned: page.pinned,
                  author: page.author,
                  updatedAt: page.updatedAt,
                  file: `${unique}/${page.path}`,
                });
                markdown.push(page.markdown);
              }
            }
            return { memory: { state: "included", pages }, markdown } satisfies GatheredMemory;
          }).pipe(
            Effect.catchTag("MemoryUnavailable", () =>
              Effect.succeed<GatheredMemory>({ memory: { state: "unavailable", pages: [] }, markdown: [] }),
            ),
          );

        /** The hobs the export names: every hob for everything, else those its records mention. */
        const namedHobs = (scope: ExportScope, gathered: Gathered, trees: ReadonlyArray<ExportedTree>) => {
          if (scope._tag === "Everything") return gathered.hobs;
          const named = new Set<string>(gathered.threads.map((thread) => thread.agentId));
          for (const tree of trees) {
            for (const task of tree.tasks) {
              named.add(task.ownerId);
              for (const attempt of task.attempts) named.add(attempt.agentId);
              for (const question of task.questions) named.add(question.askerId);
            }
            for (const quest of tree.quests) named.add(quest.leadId);
          }
          return gathered.hobs.filter((hob) => named.has(hob.id));
        };

        /** The export's records, unredacted, with where each file artifact's bytes come from. */
        const records = (scope: ExportScope, gathered: Gathered, exportedAt: string, memory: ExportedMemory) =>
          Effect.gen(function* () {
            const threads = yield* Effect.forEach(gathered.threads, (thread) =>
              Effect.map(
                repo.listMessages(thread.id),
                (messages): ExportedThread => ({
                  id: thread.id,
                  agentId: thread.agentId,
                  title: thread.title,
                  createdAt: thread.createdAt,
                  updatedAt: thread.updatedAt,
                  archivedAt: thread.archivedAt,
                  file: "",
                  messages: messages
                    .filter((message) => message.status !== "queued")
                    .map((message) => exportedMessage(message, thread.agentId)),
                }),
              ),
            );
            const trees = yield* Effect.forEach(gathered.trees, (tree) => treeRecord(tree, gathered.full));
            const sources = new Map<string, FileSource>();
            for (const tree of gathered.trees) {
              for (const artifact of tree.artifacts) {
                const task = tree.tasks.find((each) => each.id === artifact.taskId);
                if (artifact.kind === "file" && task !== undefined && gathered.full(task)) {
                  sources.set(artifact.id, { ownerId: task.ownerId, value: artifact.value });
                }
              }
            }
            const data: HobbotsExport = {
              format: EXPORT_FORMAT,
              version: EXPORT_VERSION,
              exportedAt,
              hobbotsVersion: version,
              scope,
              hobs: namedHobs(scope, gathered, trees).map(exportedHob),
              threads,
              quests: trees,
              memory,
            };
            return { data, sources };
          });

        /** Names each thread's and tree's Markdown file, once each, by its date and its redacted title. */
        const named = (data: HobbotsExport): HobbotsExport => {
          const threadNames = new Set<string>();
          const treeNames = new Set<string>();
          const fileOf = (taken: Set<string>, folder: string, at: string, title: string, fallback: string) =>
            `${folder}/${uniqueName(taken, `${at.slice(0, 10)} ${safeFileName(title, fallback)}`, ".md")}`;
          return {
            ...data,
            threads: data.threads.map((thread) => ({
              ...thread,
              file: fileOf(threadNames, "threads", thread.createdAt, thread.title, "Thread"),
            })),
            quests: data.quests.map((tree) => ({
              ...tree,
              file: fileOf(treeNames, "quests", tree.tasks[0]?.createdAt ?? data.exportedAt, tree.title, "Quest"),
            })),
          };
        };

        /**
         * Copies each file artifact still in its hob's folders into `files/<task>/`, within the size
         * limits, and says of every other one why it was not.
         */
        const copyFiles = (
          folder: string,
          data: HobbotsExport,
          sources: ReadonlyMap<string, FileSource>,
          hobs: ReadonlyArray<Agent>,
        ) =>
          Effect.gen(function* () {
            const { approvedFolders } = yield* setup.get;
            const foldersOf = new Map<string, ReadonlyArray<string>>();
            const hobFolders = (ownerId: AgentId) =>
              Effect.gen(function* () {
                const known = foldersOf.get(ownerId);
                if (known !== undefined) return known;
                const hob = hobs.find((each) => each.id === ownerId);
                const found = hob === undefined ? [] : yield* hobFoldersNow(folderChecks, approvedFolders, hob.policy);
                foldersOf.set(ownerId, found);
                return found;
              });
            let total = 0;
            const copyOne = (taskId: string, taken: Set<string>, artifact: ExportedArtifact) =>
              Effect.gen(function* () {
                const source = sources.get(artifact.id);
                if (artifact.kind !== "file" || source === undefined) return artifact;
                const refuse = (notCopied: ArtifactNotCopied): ExportedArtifact => ({ ...artifact, notCopied });
                const placed = yield* files.place(yield* hobFolders(source.ownerId), source.value);
                if (Option.isNone(placed)) return refuse("outside-folders");
                const { folder: from, path } = placed.value;
                if (isSecretFile(path)) return refuse("secret");
                const found = yield* files.look(from, path);
                if (Option.isNone(found)) return refuse("gone");
                // Checked on the file first so a file far over the limits is never read, then again on what is written.
                const over = overLimits(found.value.size, total, limits);
                if (Option.isSome(over)) return refuse(over.value);
                const bytes = yield* files.read(from, path, found.value.size);
                if (Option.isNone(bytes)) return refuse("gone");
                const contents = exportedContents(redactor, bytes.value, total, limits);
                if (contents._tag === "Skip") return refuse(contents.why);
                const base = redactor.text(path.slice(path.lastIndexOf("/") + 1));
                const copiedTo = `files/${safeFileName(taskId, "task")}/${uniqueName(taken, safeFileName(base, "file"))}`;
                yield* folders.write(folder, copiedTo, contents.bytes);
                total += contents.bytes.length;
                return { ...artifact, copiedTo };
              });
            const quests = yield* Effect.forEach(data.quests, (tree) =>
              Effect.map(
                Effect.forEach(tree.tasks, (task) => {
                  const taken = new Set<string>();
                  return Effect.map(
                    Effect.forEach(task.artifacts, (artifact) => copyOne(task.id, taken, artifact)),
                    (artifacts) => ({ ...task, artifacts }),
                  );
                }),
                (tasks) => ({ ...tree, tasks }),
              ),
            );
            return { ...data, quests };
          });

        const write = (folder: string, data: HobbotsExport, memoryMarkdown: ReadonlyArray<string>) =>
          Effect.gen(function* () {
            const names: ExportNames = new Map(data.hobs.map((hob) => [hob.id, hob.name]));
            const artifacts = data.quests.flatMap((tree) => tree.tasks.flatMap((task) => task.artifacts));
            const copied = artifacts.filter((artifact) => artifact.copiedTo !== null).length;
            for (const thread of data.threads) yield* folders.write(folder, thread.file, threadMarkdown(thread, names));
            for (const tree of data.quests) yield* folders.write(folder, tree.file, treeMarkdown(tree, names));
            // Each memory page as its Markdown, through the redactor like every other string.
            for (const [index, page] of data.memory.pages.entries()) {
              yield* folders.write(folder, page.file, redactor.text(memoryMarkdown[index] ?? ""));
            }
            yield* folders.write(folder, "export.json", `${JSON.stringify(encodeExport(data), null, 2)}\n`);
            yield* folders.write(folder, "README.md", readmeMarkdown(data, names, copied));
            return {
              folder,
              threads: data.threads.length,
              quests: data.quests.length,
              files: copied,
              notCopied: artifacts.filter((artifact) => artifact.notCopied !== null).length,
            } satisfies ExportResult;
          });

        const run = (scope: ExportScope, destination: string) =>
          Effect.gen(function* () {
            const parent = yield* destinations.check(destination);
            const exportedAt = DateTime.formatIso(yield* DateTime.now);
            const gathered = yield* gather(scope);
            const memory = yield* gatherMemory(scope, gathered.hobs);
            const { data, sources } = yield* records(scope, gathered, exportedAt, memory.memory);
            // Every string, your own messages and the hobs' replies included (ADR 026).
            const redacted = named(redactor.value(data));
            const folder = yield* folders.create(parent, folderName(redacted));
            return yield* Effect.gen(function* () {
              const copied = yield* copyFiles(folder, redacted, sources, gathered.hobs);
              return yield* write(folder, copied, memory.markdown);
            }).pipe(Effect.onError(() => folders.remove(folder)));
          });

        return DataExport.of({ run });
      }),
    );
}
