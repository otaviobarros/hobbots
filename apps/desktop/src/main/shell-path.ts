import { spawn } from "node:child_process";
import { userInfo } from "node:os";
import { delimiter } from "node:path";

const marker = "__HOBBOTS_PATH__";

/** The PATH between the markers, ignoring anything the shell's startup files print around it. */
export const parseShellPath = (output: string): string | undefined =>
  new RegExp(`${marker}(.*)${marker}`).exec(output)?.[1] || undefined;

/**
 * The PATH the user's login shell sets up. An app opened from Finder gets launchd's bare PATH, so
 * Claude Code installed through nvm, Volta, asdf or a custom npm prefix would not be found without it.
 * Resolves to undefined when the shell fails or takes more than five seconds; the app then keeps the
 * PATH it has.
 */
export const loginShellPath = (timeoutMs = 5_000): Promise<string | undefined> =>
  new Promise((done) => {
    try {
      const shell = process.env.SHELL || userInfo().shell || "/bin/zsh";
      // Interactive and login, so both ~/.zprofile and ~/.zshrc (or their bash and fish equivalents) run.
      // No stdin, so a startup file that prompts gets end-of-file instead of waiting.
      // Its own process group, so a timeout also stops whatever the startup files started.
      const child = spawn(shell, ["-ilc", `printf '${marker}%s${marker}' "$PATH"`], {
        stdio: ["ignore", "pipe", "ignore"],
        env: { ...process.env, DISABLE_AUTO_UPDATE: "true" },
        detached: true,
      });
      let output = "";
      const timer = setTimeout(() => {
        // Interactive shells ignore SIGTERM.
        try {
          if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
        } catch {}
        done(undefined);
      }, timeoutMs);
      child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
        output += chunk;
        const path = parseShellPath(output);
        if (path === undefined) return;
        // Done once the PATH is printed: a background job the startup files left running may keep
        // the output open long after the shell exits.
        clearTimeout(timer);
        child.stdout.destroy();
        child.unref();
        done(path);
      });
      child.on("error", () => done(undefined));
      child.on("close", () => {
        clearTimeout(timer);
        done(parseShellPath(output));
      });
    } catch {
      done(undefined);
    }
  });

/** The shell's folders first, then any the app already had, without duplicates. */
export const mergePaths = (...paths: ReadonlyArray<string | undefined>): string =>
  [...new Set(paths.flatMap((path) => (path ?? "").split(delimiter)).filter((dir) => dir !== ""))].join(delimiter);
