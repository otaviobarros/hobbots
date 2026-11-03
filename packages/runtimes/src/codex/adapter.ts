import { AdditionalRuntimes, RuntimeAdapter, RuntimeError } from "@hobbots/agents";
import { type RuntimeEnforcement, RuntimeHealth } from "@hobbots/domain";
import { DateTime, type Duration, Effect, Layer, Stream } from "effect";
import { ChildProcessSpawner } from "effect/process";
import { expiringCache, modelListMaxAge } from "../claude-code.ts";
import { type AppServer, startAppServer } from "./app-server.ts";
import { billingOf, readSignIn } from "./auth.ts";
import { codexEnv, codexLocator, minimumCodexVersion } from "./locate.ts";
import { codexFallbackModels, listModels, toCodexModels } from "./models.ts";

export interface CodexConfig {
  /** Codex binary to run instead of the one found on this machine. */
  readonly executable?: string | undefined;
  /** How long a health or model check waits for Codex to answer (30 seconds by default). */
  readonly checkTimeout?: Duration.Input | undefined;
  /** Hobbots' version, which Codex adds to its user agent. */
  readonly clientVersion: string;
}

const installGuidance = "Install Codex with `npm install -g @openai/codex`, then sign in with `codex login`.";
const notStarted = `Codex could not be started. ${installGuidance}`;
const outdated = `Hobbots needs Codex ${minimumCodexVersion} or later. Run \`npm install -g @openai/codex\`.`;

const notYet = { status: "unsupported", evidence: "Hobbots does not run Codex turns yet." } as const;

/** What the Codex adapter enforces until it runs turns: nothing, so nothing is offered as safe. */
export const codexEnforcement: RuntimeEnforcement = {
  toolInterception: notYet,
  processSandbox: notYet,
  hubTools: notYet,
  toolEvents: notYet,
  toolInterruption: notYet,
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

    // Finds Codex and checks its version before starting it.
    const health = Effect.gen(function* () {
      const checkedAt = DateTime.formatIso(yield* DateTime.now);
      const located = yield* locate;
      switch (located._tag) {
        case "Missing":
          return runtimeHealth({
            availability: "unavailable",
            billing: null,
            version: null,
            detail: installGuidance,
            checkedAt,
          });
        case "Broken":
          return runtimeHealth({
            availability: "unavailable",
            billing: null,
            version: null,
            detail: `${located.binary} did not report a Codex version. ${notStarted}`,
            checkedAt,
          });
        case "Outdated":
          return runtimeHealth({
            availability: "outdated",
            billing: null,
            version: located.version,
            detail: outdated,
            checkedAt,
          });
        case "Found":
          return yield* probe(located.binary, located.version, checkedAt);
      }
    });

    // Each binary's list is kept for a while, since starting Codex takes a moment. A sign-in can
    // change the list without a new binary, so it is fetched again when it expires.
    const modelCache = expiringCache(modelListMaxAge);
    const models = Effect.gen(function* () {
      const located = yield* locate;
      if (located._tag !== "Found") return codexFallbackModels;
      return yield* modelCache(
        `${located.binary}@${located.version}`,
        askAppServer(located.binary, listModels).pipe(
          Effect.map((listed) => (listed.length === 0 ? codexFallbackModels : toCodexModels(listed))),
          Effect.orElseSucceed(() => codexFallbackModels),
        ),
      );
    });

    return RuntimeAdapter.of({
      health,
      models,
      enforcement: Effect.succeed(codexEnforcement),
      // Turns arrive with #438; until then a Codex turn fails instead of pretending to run.
      sendPrompt: () => Stream.fail(new RuntimeError({ message: "Hobbots cannot run Codex turns yet." })),
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
