import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Account, Model } from "../src/codex/protocol.ts";

/** What the stand-in Codex answers, playing `codex --version` and `codex app-server`. */
export interface FakeCodexOptions {
  /** What `codex --version` prints; empty prints nothing. */
  readonly version?: string;
  /** What `account/read` answers; null while signed out. */
  readonly account?: Account | null;
  readonly workspace?: string | null;
  /** The access token `getAuthStatus` gives when asked for one. */
  readonly token?: string | null;
  /** `model/list`'s pages, in order. */
  readonly pages?: ReadonlyArray<ReadonlyArray<Partial<Model>>>;
  /** `silent` never answers; `exit` exits after `initialize`; `ask` sends the client a request first. */
  readonly behavior?: "answer" | "silent" | "exit" | "ask";
}

const model = (fields: Partial<Model>): Model => ({
  id: "gpt-test",
  model: "gpt-test",
  displayName: "GPT Test",
  description: "A test model",
  hidden: false,
  supportedReasoningEfforts: [],
  defaultReasoningEffort: "medium",
  inputModalities: ["text"],
  isDefault: false,
  ...fields,
});

/**
 * Writes an executable stand-in for Codex that speaks the App Server's JSON-RPC over stdio and
 * logs every message it receives to `<folder>/codex.log`, one JSON line each.
 */
export const fakeCodex = (folder: string, options: FakeCodexOptions = {}): string => {
  mkdirSync(folder, { recursive: true });
  const path = join(folder, "codex");
  const config = {
    version: options.version ?? "codex-cli 0.166.0",
    account: options.account ?? null,
    workspace: options.workspace ?? null,
    token: options.token ?? null,
    pages: (options.pages ?? [[{}]]).map((page) => page.map(model)),
    behavior: options.behavior ?? "answer",
    log: join(folder, "codex.log"),
  };
  writeFileSync(
    path,
    `#!/usr/bin/env node
const fs = require("node:fs");
const config = ${JSON.stringify(config)};
if (process.argv.includes("--version")) {
  if (config.version) process.stdout.write(config.version + "\\n");
  process.exit(0);
}
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
const results = {
  initialize: () => ({ userAgent: "fake", codexHome: "/fake", platformFamily: "unix", platformOs: "linux" }),
  "account/read": () => ({
    account: config.account,
    requiresOpenaiAuth: true,
    workspaceRouting: config.workspace ? { chatgptAccountId: config.workspace, backendOrigin: "https://chatgpt.invalid" } : null,
  }),
  getAuthStatus: (params) => ({
    authMethod: config.account ? "chatgpt" : null,
    authToken: params.includeToken ? config.token : null,
    requiresOpenaiAuth: true,
  }),
  "model/list": (params) => {
    const index = params.cursor ? Number(params.cursor) : 0;
    return { data: config.pages[index] ?? [], nextCursor: index + 1 < config.pages.length ? String(index + 1) : null };
  },
};
let buffered = "";
process.stdin.on("data", (chunk) => {
  buffered += chunk;
  for (let end = buffered.indexOf("\\n"); end >= 0; end = buffered.indexOf("\\n")) {
    const line = buffered.slice(0, end);
    buffered = buffered.slice(end + 1);
    fs.appendFileSync(config.log, line + "\\n");
    const message = JSON.parse(line);
    if (message.method === undefined || message.id === undefined) continue;
    if (config.behavior === "silent") continue;
    if (config.behavior === "ask" && message.method === "initialize") {
      send({ id: "ask-1", method: "item/tool/call", params: { tool: "lookup" } });
      send({ id: "ask-2", method: "unknown/thing", params: {} });
    }
    const result = results[message.method];
    if (result === undefined) send({ id: message.id, error: { code: -32601, message: "unknown method" } });
    else send({ id: message.id, result: result(message.params ?? {}) });
    if (config.behavior === "exit" && message.method === "initialize") setTimeout(() => process.exit(3), 50);
  }
});
`,
  );
  chmodSync(path, 0o755);
  return path;
};

/** Every message the stand-in received, in order. */
export const fakeCodexLog = (
  folder: string,
): ReadonlyArray<{ id?: unknown; method?: string; params?: unknown; result?: unknown; error?: unknown }> => {
  try {
    return readFileSync(join(folder, "codex.log"), "utf8")
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
};
