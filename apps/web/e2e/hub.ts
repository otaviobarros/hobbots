import { type ChildProcess, spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createConnection, createServer, type Socket } from "node:net";
import { join, resolve } from "node:path";
import { type BrowserContext, test as base, expect, type Locator, type Page } from "@playwright/test";
import { expectAccessible, type SetAside } from "./accessibility.ts";
import { type WindowWatch, watchWindow } from "./window-still.ts";

const web = resolve(import.meta.dirname, "..");
const server = resolve(web, "../server");
/** The server bundle that `global-setup.ts` builds before the tests run. */
const serverBuild = join(server, "dist", "main.js");

/** Where test hubs keep their data: under the checkout and git-ignored, never the user's Hobbots data. */
const dataRoot = resolve(web, "../../.data/e2e");

// One port per Playwright worker, counted up from HOBBOTS_E2E_PORT (set it beside another server):
// a worker runs one test at a time, so its hubs never overlap.
const port = Number(process.env.HOBBOTS_E2E_PORT ?? 4380) + Number(process.env.TEST_PARALLEL_INDEX ?? 0);

export interface Hub {
  /** The served web client, as the desktop app loads it. */
  readonly url: string;
  readonly dataDir: string;
  /** Headers that make an API request the hub's window's, with the key this start of the hub wrote. */
  readonly headers: Readonly<Record<string, string>>;
  /** Stops the server and waits for it to exit; the data folder stays. */
  readonly stop: () => Promise<void>;
  /** Kills the server at once, as a crash or a force quit would, and waits for it to exit. */
  readonly kill: () => Promise<void>;
}

/** A new, empty data folder for one test. */
export const emptyDataDir = (): string => {
  mkdirSync(dataRoot, { recursive: true });
  return mkdtempSync(join(dataRoot, "hub-"));
};

/**
 * The home whose Git config a test hub reads, beside its data folder: one that sets who hobs commit
 * as, so a hub never asks for it because of how this machine's Git is set up (#741).
 */
const gitHome = (dataDir: string) => {
  const home = `${dataDir}-git-home`;
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, ".gitconfig"), "[user]\n\tname = Playwright\n\temail = playwright@example.com\n");
  return home;
};

/**
 * Lets every folder under `folder` be written again: the skills library keeps each revision's
 * folders read-only (ADR 029), which a user who is not root cannot remove until they are.
 */
const writableFolders = (folder: string) => {
  chmodSync(folder, 0o755);
  for (const entry of readdirSync(folder, { withFileTypes: true })) {
    if (entry.isDirectory()) writableFolders(join(folder, entry.name));
  }
};

export const removeDataDir = (dataDir: string) => {
  if (dataDir !== "" && existsSync(dataDir)) writableFolders(dataDir);
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(`${dataDir}-git-home`, { recursive: true, force: true });
};

/**
 * Starts the hub on `dataDir` from the server build that the global setup makes from source,
 * serving the web client's build, and waits until it answers. The fake runtime is the default;
 * `env` picks another runtime or Claude Code binary, or with `HOBBOTS_GIT_HOME` another Git config. Fails when another hub answers on the port,
 * so a test never acts on someone else's data.
 */
export const startHub = async (dataDir: string, env: Record<string, string> = {}): Promise<Hub> => {
  // Node runs the bundled server itself, with nothing to transpile and no parent process, so it
  // answers within a second and a kill reaches it.
  const child = spawn(process.execPath, [serverBuild], {
    cwd: server,
    env: {
      ...process.env,
      HOBBOTS_PORT: String(port),
      // The serve listener's port for HTTPS through the fake `tailscale serve`, apart from every hub port.
      HOBBOTS_SERVE_PORT: String(port + 1000),
      HOBBOTS_DATA_DIR: dataDir,
      HOBBOTS_WEB_DIR: join(web, "dist"),
      HOBBOTS_RUNTIME: "fake",
      // No memory engine: browser tests run without the bundled ai-memory (ADR 028).
      HOBBOTS_MEMORY: "off",
      // A hub on the real runtimes never finds a Codex installed on this machine unless a test gives it one.
      HOBBOTS_CODEX_EXECUTABLE: join(dataDir, "bin", "codex"),
      HOBBOTS_GIT_HOME: env.HOBBOTS_GIT_HOME ?? gitHome(dataDir),
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout?.on("data", (chunk) => (output += chunk));
  child.stderr?.on("data", (chunk) => (output += chunk));

  const url = `http://127.0.0.1:${port}`;
  // The health endpoint reports the canonical data folder of the hub that answered.
  const ours = realpathSync(dataDir);
  const fail = async (problem: string) => {
    await stopProcess(child);
    throw new Error(`${problem}\n${output}`);
  };
  const deadline = Date.now() + 30_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`The hub exited with ${child.exitCode}:\n${output}`);
    const identity = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(1000) }).then(
      (response) => (response.ok ? (response.json() as Promise<{ readonly dataDir?: unknown }>) : undefined),
      () => undefined,
    );
    if (identity !== undefined) {
      if (identity.dataDir === ours) break;
      return fail(
        `Another hub (data: ${String(identity.dataDir)}) answers on ${url}; stop it or set HOBBOTS_E2E_PORT.`,
      );
    }
    if (Date.now() > deadline) return fail(`The hub did not answer on ${url} within 30s:`);
    await new Promise((done) => setTimeout(done, 200));
  }
  const key = readFileSync(join(dataDir, "window-key"), "utf8").trim();
  const hub: Hub = {
    url,
    dataDir,
    headers: { authorization: `Bearer ${key}` },
    stop: () => stopProcess(child),
    kill: () => stopProcess(child, "SIGKILL"),
  };
  if (activeContext !== undefined) await admit(activeContext, hub);
  return hub;
};

/** The `name=value` pairs a response set as cookies. */
const setCookies = (response: Response) =>
  new Map(
    response.headers.getSetCookie().map((line) => {
      const pair = line.split(";")[0] ?? "";
      const equals = pair.indexOf("=");
      return [pair.slice(0, equals), pair.slice(equals + 1)] as const;
    }),
  );

const DEVICE_COOKIE = "hobbots_device";

/**
 * Gives a browser context a device on the hub without the prompt (ADR 021): it asks to pair as a
 * browser, the hub's window allows it, and the device cookie goes into the context. A context that
 * already has one, as after the hub restarts on the same data folder, keeps it.
 */
export const admit = async (context: BrowserContext, hub: Hub) => {
  if ((await context.cookies(hub.url)).some((cookie) => cookie.name === DEVICE_COOKIE)) return;
  const fail = async (step: string, response: Response) => {
    throw new Error(`Pairing the test browser failed at ${step}: ${response.status} ${await response.text()}`);
  };
  const opened = await fetch(`${hub.url}/api/pairing`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Playwright", platform: "test", kind: "browser" }),
  });
  if (!opened.ok) return fail("asking", opened);
  const { status } = (await opened.json()) as { readonly status: { readonly id: string } };
  const pairing = setCookies(opened).get("hobbots_pairing");
  const allowed = await fetch(`${hub.url}/api/pairing/requests/${status.id}/allow`, {
    method: "POST",
    headers: hub.headers,
  });
  if (!allowed.ok) return fail("allowing", allowed);
  const claimed = await fetch(`${hub.url}/api/pairing`, { headers: { cookie: `hobbots_pairing=${pairing}` } });
  const token = setCookies(claimed).get(DEVICE_COOKIE);
  if (!claimed.ok || token === undefined) return fail("claiming", claimed);
  await context.addCookies([{ name: DEVICE_COOKIE, value: token, url: hub.url, httpOnly: true, sameSite: "Strict" }]);
};

// The context of the test running on this worker; a hub started during the test admits it.
let activeContext: BrowserContext | undefined;

/**
 * Playwright's `test`, whose browser context gets a device on each hub the test starts. `scan` checks
 * what its page shows now, or one part of it, for serious and critical accessibility violations
 * (STD-TEST-007). Every test also fails when, on any screen it visited, the window scrolled or grew
 * taller than the viewport, or something escaped the panel it scrolls in (STD-TEST-010); `windowStill`
 * checks a page now and holds what was found.
 */
export const test = base.extend<{
  readonly hubDevice: undefined;
  readonly windowStill: WindowWatch;
  readonly scan: (within?: Locator, setAside?: SetAside) => Promise<void>;
}>({
  scan: async ({ page }, use) => {
    await use((within, setAside) => expectAccessible(page, within, setAside));
  },
  windowStill: [
    async ({ context }, use) => {
      const watch = await watchWindow(context);
      await use(watch);
      await watch.checkOpenPages();
      expect(watch.breaks(), "The window must never scroll (#1026, STD-TEST-010)").toEqual([]);
    },
    { auto: true },
  ],
  hubDevice: [
    async ({ context }, use) => {
      activeContext = context;
      await use(undefined);
      activeContext = undefined;
    },
    { auto: true },
  ],
});

export { expect } from "@playwright/test";

/** Opens the sidebar on every page this context loads, as a user who keeps it expanded would. */
export const expandSidebar = (context: BrowserContext) =>
  context.addInitScript(() => localStorage.setItem("sidebar.open", "true"));

/**
 * A camp for the hob, made as Make a camp makes one (ADR 037), titled `title`: a thread of its own
 * beside the hob's one chat. Gives back its address in the web client.
 */
export const campAt = async (current: Pick<Hub, "url" | "headers">, hobId: string, title: string) => {
  const response = await fetch(`${current.url}/api/agents/${hobId}/camps`, {
    method: "POST",
    headers: { ...current.headers, "content-type": "application/json" },
    body: JSON.stringify({ key: crypto.randomUUID(), title, goal: null, private: false }),
  });
  if (!response.ok) throw new Error(`Make a camp answered ${response.status}: ${await response.text()}`);
  const camp = (await response.json()) as { readonly id: string };
  return { id: camp.id, url: `${current.url}/#/hobs/${hobId}/threads/${camp.id}` };
};

/** The open hob's chat and camps in the expanded sidebar, each a link named by its title; its chat is "Chat". */
export const sidebarThread = (page: Page, title: string) =>
  page.getByRole("navigation", { name: "Sections" }).getByRole("link", { name: title, exact: true });

const stopProcess = (child: ChildProcess, signal: NodeJS.Signals = "SIGTERM") =>
  new Promise<void>((done) => {
    if (child.exitCode !== null || child.signalCode !== null) return done();
    child.once("exit", () => done());
    child.kill(signal);
  });

/** A network path between a page and the hub that a test can cut and restore, as a dropped Wi-Fi would. */
export interface Relay {
  /** Where the page opens the hub through this relay. */
  readonly url: string;
  /** Drops every open connection and refuses new ones until `restore`. */
  readonly cut: () => void;
  readonly restore: () => void;
  readonly close: () => Promise<void>;
}

/** Relays TCP connections to the hub's port, 2000 above it: clear of every hub and serve port. */
export const startRelay = async (): Promise<Relay> => {
  const relayPort = port + 2000;
  const open = new Set<Socket>();
  let accepting = true;
  const server = createServer((client) => {
    if (!accepting) return client.destroy();
    const upstream = createConnection({ host: "127.0.0.1", port });
    for (const socket of [client, upstream]) {
      open.add(socket);
      socket.on("close", () => open.delete(socket));
      socket.on("error", () => {
        client.destroy();
        upstream.destroy();
      });
    }
    client.pipe(upstream).pipe(client);
  });
  await new Promise<void>((done) => server.listen(relayPort, "127.0.0.1", done));
  return {
    url: `http://127.0.0.1:${relayPort}`,
    cut: () => {
      accepting = false;
      for (const socket of open) socket.destroy();
    },
    restore: () => {
      accepting = true;
    },
    close: () =>
      new Promise<void>((done) => {
        for (const socket of open) socket.destroy();
        server.close(() => done());
      }),
  };
};

/**
 * A stand-in Claude Code that is installed but signed out: it prints a version and answers the
 * Agent SDK's initialize request with an empty account, as a binary with no login does. The real
 * Claude Code adapter starts it, so the check goes through the same path as on a user's Mac.
 */
export const signedOutClaudeCode = (dataDir: string): string => claudeCodeAt(dataDir, {});

/** A stand-in Claude Code signed in to a claude.ai plan, which the real adapter reports as ready. */
export const signedInClaudeCode = (dataDir: string): string =>
  claudeCodeAt(dataDir, { email: "player@example.com", subscriptionType: "pro" });

/** Writes a stand-in Claude Code where the hub is told to look, answering with `account`. */
const claudeCodeAt = (dataDir: string, account: Record<string, string>): string => {
  const path = join(dataDir, "bin", "claude");
  mkdirSync(join(dataDir, "bin"), { recursive: true });
  writeFileSync(
    path,
    `#!/usr/bin/env node
if (process.argv.includes("--version")) {
  process.stdout.write("9.9.9 (Claude Code)\\n");
  process.exit(0);
}
let buffered = "";
process.stdin.on("data", (chunk) => {
  buffered += chunk;
  for (let end = buffered.indexOf("\\n"); end >= 0; end = buffered.indexOf("\\n")) {
    const message = JSON.parse(buffered.slice(0, end));
    buffered = buffered.slice(end + 1);
    if (message.type !== "control_request") continue;
    const response = message.request.subtype === "initialize" ? { commands: [], models: [], account: ${JSON.stringify(account)} } : {};
    const reply = { type: "control_response", response: { subtype: "success", request_id: message.request_id, response } };
    process.stdout.write(JSON.stringify(reply) + "\\n");
  }
});
`,
  );
  chmodSync(path, 0o755);
  return path;
};

/** What the stand-in Codex reports: its version and how it is signed in. */
export type FakeCodexState = "outdated" | "signedOut" | "apiKey" | "ready";

const CODEX_ACCOUNTS: Record<FakeCodexState, unknown> = {
  outdated: null,
  signedOut: null,
  apiKey: { type: "apiKey" },
  ready: { type: "chatgpt", email: "player@example.com", planType: "plus", workspaceName: null },
};

/** The one model the stand-in Codex lists, in the App Server's shape. */
const CODEX_MODEL = {
  id: "gpt-5.5",
  model: "gpt-5.5",
  displayName: "GPT-5.5",
  description: "Frontier model for complex coding",
  hidden: false,
  supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "medium" }, { reasoningEffort: "high" }],
  defaultReasoningEffort: "medium",
  inputModalities: ["text"],
  isDefault: true,
};

/**
 * Writes a stand-in for Codex where the hub looks for it (`<dataDir>/bin/codex`), answering
 * `--version`, `account/read` and `model/list` (one model) over the App Server's JSON-RPC.
 */
export const fakeCodexAt = (dataDir: string, state: FakeCodexState): string => {
  const path = join(dataDir, "bin", "codex");
  mkdirSync(join(dataDir, "bin"), { recursive: true });
  const version = state === "outdated" ? "0.100.0" : "0.166.0";
  writeFileSync(
    path,
    `#!/usr/bin/env node
if (process.argv.includes("--version")) {
  process.stdout.write("codex-cli ${version}\\n");
  process.exit(0);
}
const results = {
  initialize: { userAgent: "fake", codexHome: "/fake", platformFamily: "unix", platformOs: "linux" },
  "account/read": { account: ${JSON.stringify(CODEX_ACCOUNTS[state])}, requiresOpenaiAuth: true, workspaceRouting: null },
  "model/list": { data: [${JSON.stringify(CODEX_MODEL)}], nextCursor: null },
};
let buffered = "";
process.stdin.on("data", (chunk) => {
  buffered += chunk;
  for (let end = buffered.indexOf("\\n"); end >= 0; end = buffered.indexOf("\\n")) {
    const message = JSON.parse(buffered.slice(0, end));
    buffered = buffered.slice(end + 1);
    if (message.id === undefined) continue;
    process.stdout.write(JSON.stringify({ id: message.id, result: results[message.method] ?? {} }) + "\\n");
  }
});
`,
  );
  chmodSync(path, 0o755);
  return path;
};
