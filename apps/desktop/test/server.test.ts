import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { initialStatus, nextStatus, type ServerProcess, ServerSupervisor, StartTimedOut } from "../src/main/server.ts";

/** A server process that exits when asked, or ignores the request when `stubborn`. */
class FakeProcess extends EventEmitter implements ServerProcess {
  readonly pid = 4242;
  killed = 0;
  constructor(private readonly stubborn = false) {
    super();
  }
  kill() {
    this.killed++;
    if (!this.stubborn) setTimeout(() => this.emit("exit", 0), 5);
    return true;
  }
  override once(event: "exit", listener: (code: number) => void) {
    return super.once(event, listener);
  }
}

const supervisorWith = (options: { up: () => boolean; child?: FakeProcess; stopTimeoutMs?: number }) => {
  const child = options.child ?? new FakeProcess();
  const forceKilled: number[] = [];
  let launches = 0;
  const supervisor = new ServerSupervisor({
    apiUrl: "http://127.0.0.1:4345",
    probe: async () => (options.up() ? "ours" : "none"),
    launch: async () => {
      launches++;
      return child;
    },
    startTimeoutMs: 200,
    stopTimeoutMs: options.stopTimeoutMs ?? 1_000,
    forceKill: (pid) => {
      forceKilled.push(pid);
      child.emit("exit", 137);
    },
  });
  const states: string[] = [];
  supervisor.onChange((status) => states.push(status.state));
  return { supervisor, child, forceKilled, states, launches: () => launches };
};

describe("the server state machine", () => {
  it("reports an owned server that exits without being asked as an error", () => {
    const running = nextStatus(nextStatus(initialStatus, { type: "launching" }), { type: "healthy" });
    expect(running).toMatchObject({ state: "running", owned: true });
    expect(nextStatus(running, { type: "exited", code: 1 })).toMatchObject({
      state: "error",
      problem: "The server stopped unexpectedly (exit code 1).",
    });
    const stopping = nextStatus(running, { type: "stopping" });
    expect(nextStatus(stopping, { type: "exited", code: 0 })).toMatchObject({ state: "stopped", stopping: false });
  });

  it("reports a server it attached to as stopped once it stops answering, and never stops it", () => {
    const attached = nextStatus(initialStatus, { type: "attached" });
    expect(attached).toMatchObject({ state: "running", owned: false });
    expect(nextStatus(attached, { type: "stopping" })).toBe(attached);
    expect(nextStatus(attached, { type: "unreachable" })).toMatchObject({ state: "stopped" });
  });

  it("reports an owned server that stops answering as an error it still owns", () => {
    const running = nextStatus(nextStatus(initialStatus, { type: "launching" }), { type: "healthy" });
    const stuck = nextStatus(running, { type: "unreachable" });
    expect(stuck).toMatchObject({ state: "error", owned: true, problem: "The server stopped answering." });
    expect(nextStatus(stuck, { type: "healthy" })).toMatchObject({ state: "running", problem: null });
  });
});

describe("ServerSupervisor", () => {
  // covers EX-005, DP-001
  it("[TC-EX-002] attaches to a server already running and leaves it running on stop", async () => {
    const { supervisor, child, launches } = supervisorWith({ up: () => true });
    await supervisor.start();
    expect(supervisor.status).toMatchObject({ state: "running", owned: false });
    await supervisor.stop();
    expect(launches()).toBe(0);
    expect(child.killed).toBe(0);
  });

  // covers EX-005
  it("[TC-EX-003] launches its own server, stops it gracefully on Quit and reports a crash as an error", async () => {
    let up = false;
    const { supervisor, child, states } = supervisorWith({ up: () => up });
    const started = supervisor.start();
    up = true;
    await started;
    expect(supervisor.status).toMatchObject({ state: "running", owned: true });

    await supervisor.stop();
    expect(child.killed).toBe(1);
    expect(supervisor.status.state).toBe("stopped");
    expect(states).toEqual(["starting", "running", "running", "stopped"]);

    // The next server dies on its own.
    up = false;
    const restarted = supervisor.start();
    up = true;
    await restarted;
    child.emit("exit", 1);
    expect(supervisor.status).toMatchObject({
      state: "error",
      problem: "The server stopped unexpectedly (exit code 1).",
    });
  });

  // covers EX-005
  it("[TC-EX-004] kills a server that ignores the stop request after the timeout", async () => {
    let up = false;
    const { supervisor, child, forceKilled } = supervisorWith({
      up: () => up,
      child: new FakeProcess(true),
      stopTimeoutMs: 20,
    });
    const started = supervisor.start();
    up = true;
    await started;
    await supervisor.stop();
    expect(child.killed).toBe(1);
    expect(forceKilled).toEqual([4242]);
    expect(supervisor.status.state).toBe("stopped");
  });

  // covers EX-005
  it("[TC-EX-005] launches one server when starts overlap", async () => {
    let up = false;
    const { supervisor, launches } = supervisorWith({ up: () => up });
    const first = supervisor.start();
    const second = supervisor.start();
    up = true;
    await Promise.all([first, second]);
    expect(launches()).toBe(1);
    expect(supervisor.status).toMatchObject({ state: "running", owned: true });
  });

  // covers EX-005
  it("[TC-EX-006] shows a stuck server as an error, replaces it on restart and ignores its late exit", async () => {
    let up = false;
    const stuck = new FakeProcess(true);
    const next = new FakeProcess();
    const children = [stuck, next];
    const supervisor = new ServerSupervisor({
      apiUrl: "http://127.0.0.1:4345",
      probe: async () => (up ? "ours" : "none"),
      // The new server answers once it is launched.
      launch: async () => {
        up = true;
        return children.shift() ?? next;
      },
      startTimeoutMs: 200,
      stopTimeoutMs: 20,
      forceKill: () => {},
    });
    await supervisor.start();

    up = false;
    await supervisor.check();
    expect(supervisor.status).toMatchObject({ state: "error", owned: true, problem: "The server stopped answering." });
    expect(supervisor.ownsProcess).toBe(true);

    await supervisor.start();
    expect(stuck.killed).toBe(1);
    expect(supervisor.status).toMatchObject({ state: "running", owned: true });

    stuck.emit("exit", 137);
    expect(supervisor.status.state).toBe("running");
    await supervisor.stop();
    expect(next.killed).toBe(1);
    expect(supervisor.status.state).toBe("stopped");
  }, 10_000);

  // covers EX-005
  it("[TC-EX-007] quits during a restart without launching another server", async () => {
    let up = false;
    let launches = 0;
    const stuck = new FakeProcess(true);
    const supervisor = new ServerSupervisor({
      apiUrl: "http://127.0.0.1:4345",
      probe: async () => (up ? "ours" : "none"),
      launch: async () => {
        launches++;
        up = true;
        return launches === 1 ? stuck : new FakeProcess();
      },
      startTimeoutMs: 200,
      stopTimeoutMs: 50,
      forceKill: () => stuck.emit("exit", 137),
    });
    await supervisor.start();
    up = false;
    await supervisor.check();
    expect(supervisor.status.state).toBe("error");

    // The restart waits for the stuck server to stop; Quit comes meanwhile.
    const restart = supervisor.start();
    await supervisor.shutdown();
    await restart;
    expect(launches).toBe(1);
    expect(supervisor.ownsProcess).toBe(false);
  });

  it("reports a stranger on the port as an error and never launches", async () => {
    let launches = 0;
    const supervisor = new ServerSupervisor({
      apiUrl: "http://127.0.0.1:4345",
      probe: async () => {
        throw new Error("Another program is using port 4345");
      },
      launch: async () => {
        launches++;
        return new FakeProcess();
      },
    });
    await expect(supervisor.start()).rejects.toThrow("Another program is using port 4345");
    expect(supervisor.status).toMatchObject({ state: "error", problem: "Another program is using port 4345" });
    expect(launches).toBe(0);
  });

  it("reports a server that never answers as an error and stops it", async () => {
    const { supervisor, child } = supervisorWith({ up: () => false });
    await expect(supervisor.start()).rejects.toBeInstanceOf(StartTimedOut);
    expect(supervisor.status).toMatchObject({
      state: "error",
      problem: "The server did not start on http://127.0.0.1:4345.",
    });
    expect(child.killed).toBe(1);
  });
});
