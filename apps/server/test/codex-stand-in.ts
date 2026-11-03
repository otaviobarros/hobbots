import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** A turn the stand-in Codex ran: the thread it ran on, its input, and what each hub tool call was answered. */
export interface StandInTurn {
  readonly thread: string;
  readonly input: string;
  readonly answers: ReadonlyArray<{ readonly tool: string; readonly text: string; readonly success: boolean }>;
}

/**
 * Writes an executable stand-in for Codex 0.166.0, signed in with ChatGPT, whose model follows the
 * fake runtime's `fake:hub <tool> <json input>` lines: each line of a turn's input is one call to a
 * hub tool the thread declared, sent to the client as `item/tool/call` (ADR 024). Like Codex, a
 * thread keeps the dynamic tools it started with, and a model only calls a tool it was offered.
 * Each turn is logged to `<folder>/turns.log`, one JSON line each.
 */
export const codexStandIn = (folder: string): string => {
  mkdirSync(folder, { recursive: true });
  const path = join(folder, "codex");
  const log = join(folder, "turns.log");
  writeFileSync(
    path,
    `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
if (process.argv.includes("--version")) {
  process.stdout.write("codex-cli 0.166.0\\n");
  process.exit(0);
}
const home = process.env.CODEX_HOME || ${JSON.stringify(folder)};
const threads = path.join(home, "stand-in-threads");
fs.mkdirSync(threads, { recursive: true });
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
const waiting = new Map();
let asked = 0;
const ask = (method, params) =>
  new Promise((resolve) => {
    const id = "ask-" + ++asked;
    waiting.set(id, resolve);
    send({ id, method, params });
  });
const toolsOf = (thread) => JSON.parse(fs.readFileSync(path.join(threads, thread + ".json"), "utf8"));
const runTurn = async (thread, turn, input) => {
  const offered = toolsOf(thread);
  const answers = [];
  const calls = input
    .split("\\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("fake:hub "))
    .map((line) => {
      const [tool, ...rest] = line.slice("fake:hub ".length).split(" ");
      return { tool, input: rest.length > 0 ? JSON.parse(rest.join(" ")) : {} };
    })
    .filter((call) => offered.includes(call.tool));
  const note = (method, params) => send({ method, params: { threadId: thread, turnId: turn, ...params } });
  for (const call of calls) {
    const id = "call-" + crypto.randomUUID();
    const item = { type: "dynamicToolCall", id, namespace: null, tool: call.tool, arguments: call.input };
    note("item/started", { item: { ...item, status: "inProgress", contentItems: null, success: null } });
    const answer = await ask("item/tool/call", { threadId: thread, turnId: turn, callId: id, namespace: null, tool: call.tool, arguments: call.input });
    const text = (answer.contentItems || []).map((content) => content.text).join("");
    answers.push({ tool: call.tool, text, success: answer.success });
    note("item/completed", {
      item: { ...item, status: answer.success ? "completed" : "failed", contentItems: answer.contentItems, success: answer.success },
    });
  }
  fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ thread, input, answers }) + "\\n");
  const text = calls.length === 0 ? "Noted." : "Done.";
  note("item/completed", { item: { type: "agentMessage", id: "msg-" + turn, text } });
  note("turn/completed", { turn: { id: turn, items: [], status: "completed", error: null } });
};
const results = {
  initialize: () => ({ userAgent: "stand-in", codexHome: home, platformFamily: "unix", platformOs: "linux" }),
  "account/read": () => ({
    account: { type: "chatgpt", email: "you@example.com", planType: "plus", workspaceName: null },
    requiresOpenaiAuth: true,
    workspaceRouting: { chatgptAccountId: "workspace", backendOrigin: "https://chatgpt.invalid" },
  }),
  getAuthStatus: (params) => ({ authMethod: "chatgpt", authToken: params.includeToken ? "token" : null, requiresOpenaiAuth: true }),
  "model/list": () => ({
    data: [{ id: "gpt-stand-in", model: "gpt-stand-in", displayName: "Stand-in", description: "", hidden: false,
      supportedReasoningEfforts: [], defaultReasoningEffort: "medium", inputModalities: ["text"], isDefault: true }],
    nextCursor: null,
  }),
  "account/login/start": () => ({}),
  "thread/start": (params) => {
    const id = "thr-" + crypto.randomUUID();
    fs.writeFileSync(path.join(threads, id + ".json"), JSON.stringify((params.dynamicTools || []).map((tool) => tool.name)));
    return { thread: { id }, model: "gpt-stand-in" };
  },
  "thread/resume": (params) => ({ thread: { id: params.threadId }, model: "gpt-stand-in" }),
  "turn/start": (params) => {
    const id = "turn-" + crypto.randomUUID();
    const input = params.input.map((part) => part.text).join("\\n");
    setTimeout(() => runTurn(params.threadId, id, input), 0);
    return { turn: { id, status: "inProgress", error: null } };
  },
  "turn/interrupt": () => ({}),
};
let buffered = "";
process.stdin.on("data", (chunk) => {
  buffered += chunk;
  for (let end = buffered.indexOf("\\n"); end >= 0; end = buffered.indexOf("\\n")) {
    const message = JSON.parse(buffered.slice(0, end));
    buffered = buffered.slice(end + 1);
    if (message.method === undefined) {
      waiting.get(message.id)?.(message.result || { contentItems: [], success: false });
      waiting.delete(message.id);
      continue;
    }
    if (message.id === undefined) continue;
    const result = results[message.method];
    if (result === undefined) send({ id: message.id, error: { code: -32601, message: "unknown method" } });
    else send({ id: message.id, result: result(message.params || {}) });
  }
});
`,
  );
  chmodSync(path, 0o755);
  return path;
};

/** Every turn the stand-in ran, in order. */
export const standInTurns = (folder: string): ReadonlyArray<StandInTurn> => {
  try {
    return readFileSync(join(folder, "turns.log"), "utf8")
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => JSON.parse(line) as StandInTurn);
  } catch {
    return [];
  }
};
