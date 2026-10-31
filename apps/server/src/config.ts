import { homedir, platform } from "node:os";
import { join, resolve } from "node:path";
import { Config } from "effect";

const defaultDataDir = () =>
  platform() === "darwin" ? join(homedir(), "Library", "Application Support", "Hobbots") : join(homedir(), ".hobbots");

export const ServerConfig = Config.all({
  port: Config.Port("HOBBOTS_PORT").pipe(Config.withDefault(4317)),
  dataDir: Config.String("HOBBOTS_DATA_DIR").pipe(Config.withDefault(defaultDataDir())),
  // Reported by the health endpoint. The desktop app passes its own version; a checkout has none.
  version: Config.String("HOBBOTS_VERSION").pipe(Config.withDefault("development")),
  // The built web client. A checkout serves the web app's build; the desktop app passes the copy
  // in its resources folder.
  webDir: Config.String("HOBBOTS_WEB_DIR").pipe(Config.withDefault(resolve(import.meta.dirname, "../../web/dist"))),
  // Overrides the host Claude Code the runtime finds on its own.
  claudeExecutable: Config.String("HOBBOTS_CLAUDE_EXECUTABLE").pipe(Config.option),
  runtime: Config.Literals(["claude", "fake"], "HOBBOTS_RUNTIME").pipe(Config.withDefault("claude" as const)),
  // What the fake runtime's health check reports, to show a brain that cannot think.
  fakeAvailability: Config.Literals(
    ["ready", "outdated", "signedOut", "unavailable", "unverified"],
    "HOBBOTS_FAKE_AVAILABILITY",
  ).pipe(Config.withDefault("ready" as const)),
  // Whether the fake runtime pretends its sandbox started, or cannot start on this hub.
  fakeSandbox: Config.Literals(["on", "unavailable"], "HOBBOTS_FAKE_SANDBOX").pipe(Config.withDefault("on" as const)),
  // Only the Vite dev server needs CORS; the served web client calls the API on its own origin.
  allowedOrigins: Config.String("HOBBOTS_ALLOWED_ORIGINS").pipe(
    Config.withDefault("http://localhost:5173,http://127.0.0.1:5173"),
    Config.map((value) =>
      value
        .split(",")
        .map((origin) => origin.trim())
        .filter(Boolean),
    ),
  ),
});
