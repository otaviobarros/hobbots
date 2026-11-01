import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { dirname, sep } from "node:path";

/**
 * What a Claude Code tool call printed, as text, from the `tool_response` its PostToolUse hook gets.
 * Only the parts a person reads are kept: a command's stdout and stderr, a search's matches, a
 * fetched page or a file read. A response with none, such as an edit's, gives no output.
 */

type Fields = Readonly<Record<string, unknown>>;

const isFields = (value: unknown): value is Fields => typeof value === "object" && value !== null;
const text = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

/** A command's stdout, then its stderr, as a terminal shows them one after the other. */
const commandOutput = (response: Fields): string | undefined => {
  const stdout = text(response.stdout);
  const stderr = text(response.stderr);
  if (stdout === undefined && stderr === undefined) return undefined;
  return [stdout, stderr].filter((part) => part !== undefined && part !== "").join("\n");
};

/** A search's matched lines, or else the files it found. */
const searchOutput = (response: Fields): string | undefined => {
  const content = text(response.content);
  if (content !== undefined) return content;
  const files = response.filenames;
  return Array.isArray(files) && files.every((file) => typeof file === "string") ? files.join("\n") : undefined;
};

/** What the call printed, or undefined when it printed nothing a person reads. */
export const toolOutputText = (tool: string, response: unknown): string | undefined => {
  const output = readableOutput(tool, response);
  return output === "" ? undefined : output;
};

const readableOutput = (tool: string, response: unknown): string | undefined => {
  if (typeof response === "string") return response;
  if (!isFields(response)) return undefined;
  switch (tool) {
    case "Bash":
      return commandOutput(response);
    case "Grep":
    case "Glob":
      return searchOutput(response);
    case "WebFetch":
      return text(response.result);
    case "Read":
      return isFields(response.file) ? text(response.file.content) : undefined;
    default:
      return undefined;
  }
};

/** The most a persisted output Hobbots reads back; a larger one keeps the excerpt Claude Code returned. */
const MAX_PERSISTED_OUTPUT_BYTES = 64 * 1024 * 1024;

/** Whether `path` is inside one of `roots`, compared as real paths. */
const inside = async (path: string, roots: ReadonlyArray<string>) => {
  const folder = await realpath(dirname(path));
  const real = await Promise.all(roots.map((root) => realpath(root).catch(() => null)));
  return real.some((root) => root !== null && (folder === root || folder.startsWith(`${root}${sep}`)));
};

/**
 * The whole output Claude Code saved to a file because it was too large to return inline, or
 * undefined when the file is not one to trust: outside the runtime's configuration folders, a
 * link, not a regular file the hub's user owns, or larger than Hobbots reads back.
 */
const persistedOutput = async (path: string, roots: ReadonlyArray<string>): Promise<string | undefined> => {
  if (!(await inside(path, roots))) return undefined;
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stats = await handle.stat();
    const own = process.getuid === undefined || stats.uid === process.getuid();
    if (!stats.isFile() || !own || stats.size > MAX_PERSISTED_OUTPUT_BYTES) return undefined;
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
};

/**
 * What the call printed, whole. A command whose output was too large to return inline comes back
 * as an excerpt and the path of a file with all of it, inside one of `roots` (the runtime's
 * configuration folders); that file is read instead, so neither the step nor its log holds only
 * the excerpt. A file that cannot be read or trusted leaves the excerpt.
 */
export const fullToolOutput = async (
  tool: string,
  response: unknown,
  roots: ReadonlyArray<string>,
): Promise<string | undefined> => {
  const path = tool === "Bash" && isFields(response) ? text(response.persistedOutputPath) : undefined;
  if (path !== undefined) {
    const whole = await persistedOutput(path, roots).catch(() => undefined);
    if (whole !== undefined && whole !== "") return whole;
  }
  return toolOutputText(tool, response);
};
