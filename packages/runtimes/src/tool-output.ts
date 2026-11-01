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
