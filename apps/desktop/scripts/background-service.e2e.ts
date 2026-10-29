/**
 * End-to-end checks of a packaged Hobbots.app as the hub's background service (ADR 012): closing
 * the window leaves the server and a running reply alive, a second launch shows the running
 * instance and starts no second server, and Quit stops the server the app launched.
 *
 *   HOBBOTS_E2E_APP=path/to/Hobbots.app node --test apps/desktop/scripts/background-service.e2e.ts
 *
 * Uses Node's built-in test runner so the release smoke test needs no install (Node 22.18 or
 * later, which runs TypeScript). The app runs with the fake runtime and a new, empty data folder,
 * never your Hobbots data. HOBBOTS_PORT picks the server's port (default 4317) and
 * HOBBOTS_E2E_CDP_PORT the DevTools port used to close and find the window (default 9339).
 *
 * Like any launch of an installed build, this registers that copy as a login item (ADR 012).
 */
import assert from "node:assert/strict";
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";

// `node --test` reads extra arguments as more test files, so the app comes in the environment.
const appPath = resolve(process.env.HOBBOTS_E2E_APP ?? "");
assert.match(appPath, /\.app$/, "Set HOBBOTS_E2E_APP to the Hobbots.app to test.");
const executable = join(appPath, "Contents", "MacOS", "Hobbots");

const port = Number(process.env.HOBBOTS_PORT ?? 4317);
const cdpPort = Number(process.env.HOBBOTS_E2E_CDP_PORT ?? 9339);
const api = `http://127.0.0.1:${port}/api`;
const devtools = `http://127.0.0.1:${cdpPort}`;

interface Identity {
  readonly app: string;
  readonly installationId: string;
  readonly dataDir: string;
}
interface Message {
  readonly role: string;
  readonly status: string;
  readonly content: string;
}
interface Target {
  readonly type: string;
  readonly url: string;
  readonly webSocketDebuggerUrl: string;
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

/** Polls `read` until it returns a value other than undefined, or fails after `timeoutMs`. */
const waitFor = async <A>(what: string, read: () => Promise<A | undefined>, timeoutMs = 30_000): Promise<A> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read().catch(() => undefined);
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`Timed out after ${timeoutMs / 1000}s waiting for ${what}`);
    await sleep(250);
  }
};

const getJson = async <A>(url: string, init?: RequestInit): Promise<A> => {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(2000) });
  if (!response.ok) throw new Error(`${init?.method ?? "GET"} ${url} answered ${response.status}`);
  return (await response.json()) as A;
};

const health = () => getJson<Identity>(`${api}/health`);
const isAnswering = () =>
  health().then(
    () => true,
    () => false,
  );

/** The app's windows, as the pages DevTools lists on the server's origin. */
const windows = async () =>
  (await getJson<Target[]>(`${devtools}/json/list`)).filter(
    (target) => target.type === "page" && target.url.startsWith(`http://127.0.0.1:${port}/`),
  );

/** Runs `expression` in a window's page, as a script on that page would, and returns its value. */
const evaluate = (target: Target, expression: string) =>
  new Promise<unknown>((done, fail) => {
    const socket = new WebSocket(target.webSocketDebuggerUrl);
    let value: unknown;
    socket.onopen = () =>
      socket.send(
        JSON.stringify({
          id: 1,
          method: "Runtime.evaluate",
          params: { expression, awaitPromise: true, returnByValue: true },
        }),
      );
    socket.onmessage = (event) => {
      value = JSON.parse(String(event.data))?.result?.result?.value;
      socket.close();
    };
    // window.close() may tear the page down before it answers, so the socket closing also counts.
    socket.onclose = () => done(value);
    socket.onerror = () => fail(new Error(`DevTools connection to ${target.url} failed`));
  });

/** Processes of this copy of the app: main processes, and server processes (the Node utility processes). */
const appProcesses = () => {
  const lines = execFileSync("ps", ["-axww", "-o", "command="], { encoding: "utf8" }).split("\n");
  const ours = lines.filter((line) => line.startsWith(appPath));
  return {
    main: ours.filter((line) => line.startsWith(`${executable} `) || line === executable).length,
    servers: ours.filter((line) => line.includes("--utility-sub-type=node.mojom.NodeService")).length,
  };
};

const exited = (child: ChildProcess) =>
  child.exitCode !== null || child.signalCode !== null
    ? Promise.resolve(child.exitCode)
    : new Promise<number | null>((done) => child.once("exit", (code) => done(code)));

describe("Hobbots.app as the hub's background service", { concurrency: false }, () => {
  // The real path, as the server reports it (macOS's temporary folder is behind a symlink).
  const dataDir = realpathSync(mkdtempSync(join(tmpdir(), "hobbots-e2e-")));
  const launch = (...args: string[]) =>
    spawn(executable, [`--user-data-dir=${dataDir}`, ...args], {
      env: { ...process.env, HOBBOTS_RUNTIME: "fake", HOBBOTS_PORT: String(port) },
      stdio: ["ignore", "inherit", "inherit"],
    });
  let first: ChildProcess;
  let identity: Identity;

  before(async () => {
    // The app attaches to a server already on its port, which would test that server instead.
    assert.equal(await isAnswering(), false, `A server already answers on port ${port}; stop it or set HOBBOTS_PORT.`);
    first = launch(`--remote-debugging-port=${cdpPort}`);
    identity = await waitFor("the server's health check", health, 60_000);
    // Loaded, so closing it later is a user's close rather than an aborted load.
    await waitFor("the window", async () => {
      const [window] = await windows();
      return window && (await evaluate(window, "document.readyState")) === "complete" ? true : undefined;
    });
  });

  after(async () => {
    if (first && first.exitCode === null && first.signalCode === null) {
      first.kill("SIGTERM");
      await Promise.race([exited(first), sleep(15_000)]);
      first.kill("SIGKILL");
    }
    rmSync(dataDir, { recursive: true, force: true });
  });

  // covers EX-005
  it("[TC-EX-008] keeps the server and a running reply alive after the window closes", async () => {
    assert.equal(identity.app, "hobbots");
    assert.equal(identity.dataDir, dataDir);

    const [hob] = await getJson<Array<{ id: string }>>(`${api}/agents`);
    assert.ok(hob, "the installation has a hob");
    const thread = await getJson<{ id: string }>(`${api}/agents/${hob.id}/threads`, { method: "POST" });
    // The fake runtime streams one word every 40ms, so this reply takes about 8 seconds.
    const prompt = Array.from({ length: 200 }, (_, i) => `word${i}`).join(" ");
    await getJson(`${api}/threads/${thread.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: prompt }),
    });
    const messages = () => getJson<Message[]>(`${api}/threads/${thread.id}/messages`);
    const reply = async () => (await messages()).find((message) => message.role === "assistant");
    assert.equal((await reply())?.status, "streaming", "the reply is still streaming when the window closes");

    const [window] = await windows();
    assert.ok(window);
    await evaluate(window, "window.close()");
    await waitFor("the window to close", async () => ((await windows()).length === 0 ? true : undefined));

    assert.equal(first.exitCode, null, "the app keeps running with no window");
    assert.equal(first.signalCode, null, "the app keeps running with no window");
    assert.deepEqual(await health(), identity, "the same server keeps answering");
    assert.equal((await reply())?.status, "streaming", "the reply was still streaming after the window closed");

    const done = await waitFor(
      "the reply to finish",
      async () => {
        const message = await reply();
        return message && message.status !== "streaming" ? message : undefined;
      },
      60_000,
    );
    assert.equal(done.status, "complete");
    assert.equal(done.content, `Echo: ${prompt}`);
    assert.deepEqual(await health(), identity);
  });

  // covers DP-001
  it("[TC-DP-010] a second launch shows the running instance's window and starts no second server", async () => {
    assert.deepEqual(appProcesses(), { main: 1, servers: 1 });

    const second = launch();
    const code = await Promise.race([exited(second), sleep(20_000).then(() => "still running" as const)]);
    if (code === "still running") second.kill("SIGKILL");
    assert.equal(code, 0, "the second launch quits at once");

    await waitFor("the running instance to open its window", async () =>
      (await windows()).length === 1 ? true : undefined,
    );
    assert.equal(first.exitCode, null, "the first instance keeps running");
    assert.deepEqual(await health(), identity, "the same server keeps answering");
    assert.deepEqual(appProcesses(), { main: 1, servers: 1 });
  });

  // covers EX-005
  it("[TC-EX-009] registers the login item on first start and reports what macOS made of it", async (t) => {
    const [window] = await windows();
    assert.ok(window);
    const state = (await evaluate(window, "window.hobbots.loginItem.get()")) as {
      openAtLogin: boolean;
      status: string;
    };
    // Ad-hoc signed builds can be refused (ADR 012), so the status is recorded rather than required.
    t.diagnostic(`login item status: ${state.status}`);
    assert.equal(state.openAtLogin, true, "opening at login is on by default");
    assert.ok(["enabled", "requires-approval", "not-registered", "not-found"].includes(state.status), state.status);
  });

  // covers EX-005
  it("[TC-EX-010] Quit stops the server the app launched", async () => {
    // Electron quits gracefully on SIGTERM, which runs the app's before-quit handler.
    first.kill("SIGTERM");
    const code = await Promise.race([exited(first), sleep(20_000).then(() => "still running" as const)]);
    assert.notEqual(code, "still running", "the app quits within 20s");
    await waitFor("the server to stop", async () => ((await isAnswering()) ? undefined : true), 10_000);
    assert.deepEqual(appProcesses(), { main: 0, servers: 0 });
  });
});
