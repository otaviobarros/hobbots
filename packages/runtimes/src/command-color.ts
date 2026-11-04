import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { hasEscapes, stripEscapes } from "@hobbots/domain";
import { Effect } from "effect";

/**
 * Color for a hob's commands (#902). Claude Code runs them without a terminal, so most tools print
 * no color. These variables ask them to print it anyway, so the Workbench's terminal shows a
 * command as it would look in one. Only the hob's own commands get them: Claude Code, its hooks and
 * the commands it runs for itself keep their output plain.
 */
const COMMAND_COLOR_ENV: Readonly<Record<string, string>> = {
  // Node.js, chalk, supports-color and Turborepo, at the depth the Workbench's terminal shows.
  FORCE_COLOR: "3",
  // BSD tools and many command-line programs that follow the CLICOLOR convention.
  CLICOLOR_FORCE: "1",
  // npm reads `npm_config_*`; pnpm reads only `pnpm_config_*`.
  npm_config_color: "always",
  pnpm_config_color: "always",
};

/**
 * Git takes no color variable, so it gets settings through its documented `GIT_CONFIG_COUNT` list,
 * added after any the hub set. Only diffs (`git diff`, `git log -p`, `git show`) and `git status`:
 * the commands whose output is read, not parsed by another command in a pipe as `git branch` is.
 */
const GIT_COLOR_SETTINGS: ReadonlyArray<readonly [string, string]> = [
  ["color.diff", "always"],
  ["color.status", "always"],
];

// Claude Code runs the file before each command in that command's shell, so the variable says it already ran.
const APPLIED = "HOBBOTS_COMMAND_COLOR";

/** The script Claude Code runs before each of a hob's commands, which sets the color variables. */
export const commandColorScript = (): string =>
  [
    "# Written by Hobbots: a hob's commands print in color, though they run without a terminal.",
    `if [ -z "\${${APPLIED}:-}" ]; then`,
    `  export ${APPLIED}=1`,
    ...Object.entries(COMMAND_COLOR_ENV).map(([name, value]) => `  export ${name}=${value}`),
    `  hb_git=\${GIT_CONFIG_COUNT:-0}`,
    ...GIT_COLOR_SETTINGS.flatMap(([key, value]) => [
      `  export "GIT_CONFIG_KEY_$hb_git=${key}" "GIT_CONFIG_VALUE_$hb_git=${value}"`,
      "  hb_git=$((hb_git + 1))",
    ]),
    "  export GIT_CONFIG_COUNT=$hb_git",
    "  unset hb_git",
    "fi",
    "",
  ].join("\n");

/** Claude Code's variable for the script it runs before each command. */
export const COMMAND_ENV_FILE_VARIABLE = "CLAUDE_ENV_FILE";

/**
 * Writes the color script into the hob's runtime folder, which Claude Code can read inside the
 * sandbox, and returns its path for `CLAUDE_ENV_FILE`. It is written again each turn, so a command
 * that changed it changes no later turn.
 */
export const writeCommandColorScript = async (runtimeFolder: string): Promise<string> => {
  await mkdir(runtimeFolder, { recursive: true });
  const path = join(runtimeFolder, "command-env.sh");
  await writeFile(path, commandColorScript(), { mode: 0o600 });
  return path;
};

/**
 * The color script's path for a turn with tools, or undefined for one without or when it could not
 * be written, whose commands then print plain, as they did before.
 */
export const commandColorFile = (
  tools: { readonly runtimeFolder: string } | null,
): Effect.Effect<string | undefined> =>
  tools === null
    ? Effect.succeed(undefined)
    : Effect.tryPromise(() => writeCommandColorScript(tools.runtimeFolder)).pipe(
        Effect.catch((error) =>
          Effect.logWarning(`Commands will print without color: ${String(error)}`).pipe(Effect.as(undefined)),
        ),
      );

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

/**
 * A Bash call's response without escape sequences, for the hob to read in place of the one it
 * printed, or undefined when it holds none. The Workbench keeps the colors; the hob reads plain text.
 */
export const plainBashResponse = (tool: string, response: unknown): Record<string, unknown> | undefined => {
  if (tool !== "Bash" || !isRecord(response)) return undefined;
  const fields = ["stdout", "stderr"] as const;
  const colored = fields.filter((field) => {
    const value = response[field];
    return typeof value === "string" && hasEscapes(value);
  });
  if (colored.length === 0) return undefined;
  return {
    ...response,
    ...Object.fromEntries(colored.map((field) => [field, stripEscapes(response[field] as string)])),
  };
};
