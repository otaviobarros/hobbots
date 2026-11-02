import type { ApprovalRequest, GrantRule } from "@hobbots/domain";
import { messages } from "../messages.ts";

const copy = messages.approval.rule;

/**
 * Whether the card offers Always (ADR 015): only for a request a saved rule could answer, never for
 * a high-risk one, and only when the hub said which rules Always would save.
 */
export const offersAlways = (approval: ApprovalRequest): boolean =>
  approval.grantable && !approval.onceOnly && approval.rules.length > 0;

const parentOf = (path: string) => {
  const index = path.lastIndexOf("/");
  return index <= 0 ? "/" : path.slice(0, index);
};

/** The call's own files that a folder rule covers: those directly in its folder. */
const filesIn = (approval: ApprovalRequest, folder: string) =>
  approval.targets.filter((target) => parentOf(target) === folder);

/** Whether the user can narrow the rules: a folder rule can become the exact files of the call. */
export const canNarrow = (approval: ApprovalRequest): boolean =>
  approval.rules.some((rule) => rule._tag === "Folder" && filesIn(approval, rule.folder).length > 0);

/**
 * The rules Always saves: the request's own, or with `narrow` each folder rule replaced by the exact
 * files of the call in that folder, the only narrowing the hub accepts.
 */
export const rulesToSave = (approval: ApprovalRequest, narrow: boolean): ReadonlyArray<GrantRule> =>
  narrow
    ? approval.rules.map((rule) => {
        if (rule._tag !== "Folder") return rule;
        const paths = filesIn(approval, rule.folder);
        return paths.length === 0 ? rule : { _tag: "Paths", operation: rule.operation, paths };
      })
    : approval.rules;

/** A word as the shell would read it back: quoted when it holds spaces, quotes or shell characters. */
const shellWord = (word: string) =>
  word !== "" && /^[A-Za-z0-9_./:=@%+,-]+$/.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`;

/** A command's literal words, as one line. */
export const commandText = (words: ReadonlyArray<string>): string => words.map(shellWord).join(" ");

/** One rule in words, as it will be saved: "Always let Pip run `pnpm test` in /code/app". */
export const ruleText = (rule: GrantRule, name: string): string => {
  switch (rule._tag) {
    case "Folder":
      return copy.folder[rule.operation]({ name, folder: rule.folder });
    case "Paths":
      return copy.paths[rule.operation]({ name, paths: rule.paths.join(", ") });
    case "Command":
      return copy.command({ name, command: commandText(rule.words), folder: rule.cwd });
    case "Host":
      return copy.host({ name, host: rule.host });
    case "Push":
      return copy.push({ name, branch: rule.branch, remote: rule.remote, folder: rule.cwd });
    case "PullRequest":
      return copy.pullRequest({ name, repository: rule.repository, base: rule.base });
    case "GitHubComment":
      return copy.comment({ name, repository: rule.repository });
  }
};

/** Programs whose words name a script that a file in the folder defines, and that file. */
const RUNNERS: Readonly<Record<string, string>> = {
  npm: "package.json",
  pnpm: "package.json",
  yarn: "package.json",
  bun: "package.json",
  make: "Makefile",
};

/**
 * What a command rule cannot show: a runner such as `pnpm test` runs whatever the folder's file
 * says, and the hob may be able to change that file (ADR 015). Null when no rule runs one.
 */
export const runnerNote = (rules: ReadonlyArray<GrantRule>, name: string): string | null => {
  for (const rule of rules) {
    const file = rule._tag === "Command" ? RUNNERS[rule.words[0] ?? ""] : undefined;
    if (rule._tag === "Command" && file !== undefined) {
      return copy.runner({ name, command: commandText(rule.words), file });
    }
  }
  return null;
};
