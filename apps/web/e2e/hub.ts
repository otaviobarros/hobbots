import { type ChildProcess, spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createConnection, createServer, type Socket } from "node:net";
import { join, resolve } from "node:path";
import { type BrowserContext, test as base } from "@playwright/test";

const web = resolve(import.meta.dirname, "..");
const server = resolve(web, "../server");

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

export const removeDataDir = (dataDir: string) => rmSync(dataDir, { recursive: true, force: true });

/**
 * Starts the hub from source on `dataDir`, serving the web client's build, and waits until it
 * answers. The fake runtime is the default; `env` picks another runtime or Claude Code binary.
 * Fails when another hub answers on the port, so a test never acts on someone else's data.
 */
export const startHub = async (dataDir: string, env: Record<string, string> = {}): Promise<Hub> => {
  // Node runs the server itself, with tsx as a loader rather than a parent process, so a kill reaches it.
  const child = spawn(process.execPath, ["--import", "tsx", "src/main.ts"], {
    cwd: server,
    env: {
      ...process.env,
      HOBBOTS_PORT: String(port),
      HOBBOTS_DATA_DIR: dataDir,
      HOBBOTS_WEB_DIR: join(web, "dist"),
      HOBBOTS_RUNTIME: "fake",
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

/** Playwright's `test`, whose browser context gets a device on each hub the test starts. */
export const test = base.extend<{ readonly hubDevice: undefined }>({
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

/** Relays TCP connections to the hub's port, on the next port up from the worker's hub port. */
export const startRelay = async (): Promise<Relay> => {
  const relayPort = port + 1000;
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
export const signedOutClaudeCode = (dataDir: string): string => {
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
    const response = message.request.subtype === "initialize" ? { commands: [], models: [], account: {} } : {};
    const reply = { type: "control_response", response: { subtype: "success", request_id: message.request_id, response } };
    process.stdout.write(JSON.stringify(reply) + "\\n");
  }
});
`,
  );
  chmodSync(path, 0o755);
  return path;
};
