import { Context, Effect, Layer, Option, Redacted } from "effect";
import { ChildProcessSpawner } from "effect/process";
import { runTool, toolEnv } from "./run-tool.ts";

/**
 * GitHub sign-ins already on the hub that the user can choose for the Charm instead of the app
 * (ADR 020): the GitHub CLI's, and the credential Git keeps for github.com. The hub stores neither;
 * it reads the token again for each call, so signing out of `gh` or Git ends it. Both reach every
 * repository the sign-in can see.
 */
export type LocalSource = "gh" | "git";

export class LocalGitHubSignIns extends Context.Service<
  LocalGitHubSignIns,
  {
    /** The token the sign-in holds now, or none when it is signed out or cannot be read. */
    readonly token: (source: LocalSource) => Effect.Effect<Option.Option<Redacted.Redacted<string>>>;
  }
>()("@hobbots/charms/LocalGitHubSignIns") {}

// What GitHub's tokens look like, so an error message is never taken for one.
const TOKEN = /^[A-Za-z0-9_]{20,255}$/;

const usable = (value: string | undefined) => {
  const token = value?.trim();
  return token !== undefined && TOKEN.test(token) ? Option.some(Redacted.make(token)) : Option.none();
};

/** The `password` Git's credential helper answered, from its `key=value` lines. */
export const credentialPassword = (out: string): string | undefined =>
  out
    .split("\n")
    .find((line) => line.startsWith("password="))
    ?.slice("password=".length);

/** Both sign-ins, read with `gh` and `git` on the hub, outside the sandbox. */
export const LocalGitHubSignInsLive = (env: NodeJS.ProcessEnv) =>
  Layer.effect(
    LocalGitHubSignIns,
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      // No prompts, no update checks and no pager on the hub.
      const gh = runTool(
        spawner,
        toolEnv(env, {
          GH_PROMPT_DISABLED: "1",
          GH_NO_UPDATE_NOTIFIER: "1",
          GH_PAGER: "",
          ...(env.GH_CONFIG_DIR === undefined ? {} : { GH_CONFIG_DIR: env.GH_CONFIG_DIR }),
        }),
      );
      // Git never prompts, in a terminal or a window, and finds no repository from where it runs,
      // so only the user's own Git configuration chooses the helper.
      const git = runTool(
        spawner,
        toolEnv(env, {
          GIT_TERMINAL_PROMPT: "0",
          GCM_INTERACTIVE: "never",
          GIT_ASKPASS: "",
          SSH_ASKPASS: "",
          GIT_CEILING_DIRECTORIES: "/",
        }),
      );
      const read = (source: LocalSource) =>
        source === "gh"
          ? gh("gh", ["auth", "token", "--hostname", "github.com"]).pipe(
              Effect.map((run) => (run.code === 0 ? usable(run.out) : Option.none())),
            )
          : git("git", ["-c", "credential.interactive=never", "credential", "fill"], {
              input: "protocol=https\nhost=github.com\n\n",
              cwd: "/",
            }).pipe(Effect.map((run) => (run.code === 0 ? usable(credentialPassword(run.out)) : Option.none())));
      return LocalGitHubSignIns.of({
        token: (source) => read(source).pipe(Effect.catch(() => Effect.succeed(Option.none()))),
      });
    }),
  );

/** No sign-in on the hub, as in tests. */
export const LocalGitHubSignInsNone = Layer.succeed(
  LocalGitHubSignIns,
  LocalGitHubSignIns.of({ token: () => Effect.succeed(Option.none()) }),
);

/** A GitHub CLI sign-in on the hub, for a hub started with `HOBBOTS_FAKE_GITHUB=on`. Its token reaches nothing. */
export const LocalGitHubSignInsFake = Layer.succeed(
  LocalGitHubSignIns,
  LocalGitHubSignIns.of({
    token: (source) =>
      Effect.succeed(source === "gh" ? Option.some(Redacted.make("gho_fakeHobbotsCliToken000000000")) : Option.none()),
  }),
);
