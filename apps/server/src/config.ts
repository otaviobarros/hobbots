import { homedir, platform } from "node:os";
import { join } from "node:path";
import { Config } from "effect";

const defaultDataDir = () =>
  platform() === "darwin" ? join(homedir(), "Library", "Application Support", "Hobbots") : join(homedir(), ".hobbots");

export const ServerConfig = Config.all({
  host: Config.String("HOBBOTS_HOST").pipe(Config.withDefault("127.0.0.1")),
  port: Config.Port("HOBBOTS_PORT").pipe(Config.withDefault(4317)),
  dataDir: Config.String("HOBBOTS_DATA_DIR").pipe(Config.withDefault(defaultDataDir())),
  runtime: Config.Literals(["claude", "fake"], "HOBBOTS_RUNTIME").pipe(Config.withDefault("claude" as const)),
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
