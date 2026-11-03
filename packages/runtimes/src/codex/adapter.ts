import { AdditionalRuntimes, RuntimeAdapter, RuntimeError } from "@hobbots/agents";
import { type RuntimeEnforcement, RuntimeHealth } from "@hobbots/domain";
import { type Duration, Effect, Layer } from "effect";
import { ChildProcessSpawner } from "effect/process";
import { installedRuntimeChecks, runnableBinary } from "../binary.ts";
import { type AppServer, type AppServerCommand, type AppServerOptions, startAppServer } from "./app-server.ts";
import { billingOf, chatGptTokens, readSignIn } from "./auth.ts";
import { codexEnv, codexLocator, minimumCodexVersion } from "./locate.ts";
import { codexFallbackModels, listModels, toCodexModels } from "./models.ts";
import { runCodexTurn } from "./turn.ts";

export interface CodexConfig {
  /** Codex binary to run instead of the one found on this machine. */
  readonly executable?: string | undefined;
  /** How long a health or model check waits for Codex to answer (30 seconds by default). */
  readonly checkTimeout?: Duration.Input | undefined;
  /** Hobbots' version, which Codex adds to its user agent. */
  readonly clientVersion: string;
  /** An empty folder of the hub's own, where a turn without folders starts. */
  readonly workspaceDir: string;
}

const installGuidance = "Install Codex with `npm install -g @openai/codex`, then sign in with `codex login`.";
const notStarted = `Codex could not be started. ${installGuidance}`;
const outdated = `Hobbots needs Codex ${minimumCodexVersion} or later. Run \`npm install -g @openai/codex\`.`;

const toolsClosed = {
  status: "unsupported",
  evidence: "Codex's tool calls are refused until Hobbots' policy decides them.",
} as const;

/**
 * What the Codex adapter enforces while its turns are chat-only: every tool call is refused, so no
 * tool is offered as safe (PE-005). Cancelling a turn waits for Codex to stop it (ADR 024).
 */
const codexEnforcement: RuntimeEnforcement = {
  toolInterception: toolsClosed,
  processSandbox: { status: "unsupported", evidence: "Codex does not run inside Hobbots' sandbox yet." },
  hubTools: { status: "unsupported", evidence: "Charms and coordination tools are not served to Codex yet." },
  toolEvents: toolsClosed,
  toolInterruption: {
    status: "verified",
    evidence: "Cancelling a turn sends turn/interrupt and waits for Codex's turn/completed before it ends the process.",
  },
};

export const makeCodex = (config: CodexConfig) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const locate = codexLocator(config.executable);
    const checkTimeout = config.checkTimeout ?? "30 seconds";

    // An App Server outside the sandbox, with the user's own CODEX_HOME, that sends no prompt and
    // so costs no usage (ADR 024). It ends with the check, including one that times out.
    const askAppServer = <A>(binary: string, ask: (server: AppServer) => Effect.Effect<A, unknown>) =>
      startAppServer(
        { command: binary, args: ["app-server"], env: definedEnv(codexEnv(binary)) },
        { clientVersion: config.clientVersion },
      ).pipe(
        Effect.flatMap(ask),
        Effect.timeout(checkTimeout),
        Effect.scoped,
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      );

    const runtimeHealth = (
      fields: Pick<RuntimeHealth, "availability" | "billing" | "version" | "detail" | "checkedAt">,
    ) => new RuntimeHealth({ runtime: "codex", enforcement: codexEnforcement, ...fields });

    const probe = (binary: string, version: string, checkedAt: string) =>
      askAppServer(binary, readSignIn).pipe(
        Effect.map((signIn) =>
          runtimeHealth({
            availability: signIn._tag === "ChatGpt" ? "ready" : "signedOut",
            billing: billingOf(signIn),
            version,
            // Health detail is never shown in the UI, which words each state itself.
            detail: signIn._tag === "ChatGpt" ? signIn.email : null,
            checkedAt,
          }),
        ),
        Effect.orElseSucceed(() =>
          runtimeHealth({ availability: "unavailable", billing: null, version, detail: notStarted, checkedAt }),
        ),
      );

    // Finds Codex and checks its version before starting it. A sign-in can change the model list
    // without a new binary, so the list is fetched again when it expires.
    const words = { name: "Codex", install: installGuidance, notStarted, outdated };
    const { health, models } = installedRuntimeChecks({
      locate,
      words,
      notFound: (found) => runtimeHealth({ ...found, billing: null }),
      probe,
      fallbackModels: codexFallbackModels,
      listModels: (binary) =>
        askAppServer(binary, listModels).pipe(
          Effect.map((listed) => (listed.length === 0 ? codexFallbackModels : toCodexModels(listed))),
        ),
    });

    const turnConfig = {
      // A turn runs only on a Codex that health would show as ready to start.
      binary: runnableBinary(locate, words),
      start: (command: AppServerCommand, options: AppServerOptions) =>
        startAppServer(command, options).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner)),
      // Each sign-in and refresh asks the hub's own App Server, which refreshes the user's login (ADR 024).
      signIn: (binary: string) =>
        askAppServer(binary, chatGptTokens).pipe(
          Effect.mapError(
            (error) => new RuntimeError({ message: error instanceof Error ? error.message : notStarted }),
          ),
        ),
      clientVersion: config.clientVersion,
      workspaceDir: config.workspaceDir,
    };

    return RuntimeAdapter.of({
      health,
      models,
      enforcement: Effect.succeed(codexEnforcement),
      sendPrompt: (request) => runCodexTurn(turnConfig, request),
    });
  });

/** Child processes take only defined values, so unset variables are left out. */
const definedEnv = (env: NodeJS.ProcessEnv): Record<string, string> =>
  Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined));

/** Codex beside Claude Code (ADR 017), found on this machine and checked through its App Server. */
export const CodexLayer = (config: CodexConfig) =>
  Layer.effect(
    AdditionalRuntimes,
    Effect.map(makeCodex(config), (codex) => new Map([["codex" as const, codex]])),
  );
