import { homedir, platform } from "node:os";
import { join, resolve } from "node:path";
import { HOBBOTS_GITHUB_APP } from "@hobbots/charms";
import { DEFAULT_DISPATCH_LIMITS } from "@hobbots/inbox";
import { DEFAULT_STEP_LIMITS, DEFAULT_TASK_TOOL_LIMITS } from "@hobbots/orchestration";
import { Config, Option } from "effect";

const defaultDataDir = () =>
  platform() === "darwin" ? join(homedir(), "Library", "Application Support", "Hobbots") : join(homedir(), ".hobbots");

export const ServerConfig = Config.all({
  // Overrides the port the user chose in Settings (network.json in the data folder), and 4317 without one.
  port: Config.Port("HOBBOTS_PORT").pipe(Config.option),
  dataDir: Config.String("HOBBOTS_DATA_DIR").pipe(Config.withDefault(defaultDataDir())),
  // Reported by the health endpoint. The desktop app passes its own version; a checkout has none.
  version: Config.String("HOBBOTS_VERSION").pipe(Config.withDefault("development")),
  // The built web client. A checkout serves the web app's build; the desktop app passes the copy
  // in its resources folder.
  webDir: Config.String("HOBBOTS_WEB_DIR").pipe(Config.withDefault(resolve(import.meta.dirname, "../../web/dist"))),
  // Overrides the host Claude Code the runtime finds on its own.
  claudeExecutable: Config.String("HOBBOTS_CLAUDE_EXECUTABLE").pipe(Config.option),
  // The least severe log lines the hub writes. `Debug` adds routine reads to the request log.
  logLevel: Config.LogLevel("HOBBOTS_LOG_LEVEL").pipe(Config.withDefault("Info" as const)),
  runtime: Config.Literals(["claude", "fake"], "HOBBOTS_RUNTIME").pipe(Config.withDefault("claude" as const)),
  // What the fake runtime's health check reports, to show a brain that cannot think.
  fakeAvailability: Config.Literals(
    ["ready", "outdated", "signedOut", "unavailable", "unverified"],
    "HOBBOTS_FAKE_AVAILABILITY",
  ).pipe(Config.withDefault("ready" as const)),
  // What the fake Codex's health check reports, to switch to or away from a brain that cannot think.
  fakeCodexAvailability: Config.Literals(
    ["ready", "outdated", "signedOut", "unavailable", "unverified"],
    "HOBBOTS_FAKE_CODEX_AVAILABILITY",
  ).pipe(Config.withDefault("ready" as const)),
  // How the GitHub Charm pushes (ADR 020): over HTTPS with the hub's GitHub sign-in, or over SSH
  // with the user's SSH agent, such as 1Password's. HOBBOTS_GITHUB_SSH_AGENT names the agent's socket;
  // the hub's own SSH_AUTH_SOCK when absent.
  githubPush: Config.Literals(["https", "ssh"], "HOBBOTS_GITHUB_PUSH").pipe(Config.withDefault("https" as const)),
  githubSshAgent: Config.String("HOBBOTS_GITHUB_SSH_AGENT").pipe(Config.option),
  // Whether the fake runtime pretends its sandbox started, or cannot start on this hub.
  fakeSandbox: Config.Literals(["on", "unavailable"], "HOBBOTS_FAKE_SANDBOX").pipe(Config.withDefault("on" as const)),
  // Limits every hob tool call is held to (ADR 018): how many Quests deep work may nest, and how
  // many open Tasks one hob, and one request's tree, may hold.
  taskLimits: Config.all({
    maxDepth: Config.Int("HOBBOTS_QUEST_MAX_DEPTH").pipe(Config.withDefault(DEFAULT_TASK_TOOL_LIMITS.maxDepth)),
    maxOpenTasksPerHob: Config.Int("HOBBOTS_MAX_OPEN_TASKS_PER_HOB").pipe(
      Config.withDefault(DEFAULT_TASK_TOOL_LIMITS.maxOpenTasksPerHob),
    ),
    maxOpenTasksPerTree: Config.Int("HOBBOTS_MAX_OPEN_TASKS_PER_TREE").pipe(
      Config.withDefault(DEFAULT_TASK_TOOL_LIMITS.maxOpenTasksPerTree),
    ),
  }),
  // How many steps run at once (ADR 018): per hob, and per request's tree; the rest wait their turn.
  stepLimits: Config.all({
    maxRunningStepsPerHob: Config.Int("HOBBOTS_MAX_RUNNING_STEPS_PER_HOB").pipe(
      Config.withDefault(DEFAULT_STEP_LIMITS.maxRunningStepsPerHob),
    ),
    maxRunningStepsPerTree: Config.Int("HOBBOTS_MAX_RUNNING_STEPS_PER_TREE").pipe(
      Config.withDefault(DEFAULT_STEP_LIMITS.maxRunningStepsPerTree),
    ),
  }),
  // How many times a backpack item is put into a turn before it fails as a blocker (ADR 019); at least once.
  maxDeliveries: Config.Int("HOBBOTS_BACKPACK_MAX_DELIVERIES").pipe(
    Config.withDefault(DEFAULT_DISPATCH_LIMITS.maxDeliveries),
    Config.map((count) => Math.max(1, count)),
  ),
  // The GitHub App the hub signs in through for the GitHub Charm (ADR 020): Hobbots' own unless a
  // self-hosted hub names its own. A client ID and a slug are public; the hub holds no app secret.
  githubClientId: Config.String("HOBBOTS_GITHUB_CLIENT_ID").pipe(
    Config.option,
    Config.map((id) => Option.getOrElse(id, () => HOBBOTS_GITHUB_APP.clientId)),
  ),
  githubAppSlug: Config.String("HOBBOTS_GITHUB_APP_SLUG").pipe(Config.withDefault(HOBBOTS_GITHUB_APP.slug)),
  // A GitHub token that replaces the connected account, for a hub with no keychain and for tests.
  githubToken: Config.Redacted("HOBBOTS_GITHUB_TOKEN").pipe(Config.option),
  // A stand-in for GitHub's sign-in and an in-memory keychain, to try connecting without either.
  fakeGitHub: Config.Literals(["off", "on"], "HOBBOTS_FAKE_GITHUB").pipe(Config.withDefault("off" as const)),
  // A stand-in for Tailscale on 127.0.0.2, controlled by fake-tailscale.json in the data folder (ADR 021).
  fakeTailscale: Config.Literals(["off", "on"], "HOBBOTS_FAKE_TAILSCALE").pipe(Config.withDefault("off" as const)),
  // A scripted Quest the fake runtime plays on the hub's records: asking for a Black Friday campaign starts it.
  fakeQuest: Config.Literals(["off", "black-friday"], "HOBBOTS_FAKE_QUEST").pipe(Config.withDefault("off" as const)),
});
