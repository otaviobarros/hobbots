/**
 * Supervises the hub server for the menu-bar app (ADR 012): attaches to a server already running
 * on the port or launches one it owns, follows its state for the menu-bar icon, and stops an owned
 * server gracefully on Quit. Electron stays out of this file; index.ts passes the launcher in.
 */

export type ServerState = "starting" | "running" | "stopped" | "error";

export interface ServerStatus {
  readonly state: ServerState;
  /** True when this app launched the server, so Quit stops it. A server from `pnpm dev` is not. */
  readonly owned: boolean;
  /** True from the moment this app asks its server to stop until the process exits. */
  readonly stopping: boolean;
  /** What went wrong, for the Error state. */
  readonly problem: string | null;
}

export type ServerEvent =
  | { readonly type: "launching" }
  | { readonly type: "attached" }
  | { readonly type: "healthy" }
  | { readonly type: "unreachable" }
  | { readonly type: "startFailed"; readonly problem: string }
  | { readonly type: "stopping" }
  | { readonly type: "exited"; readonly code: number };

export const initialStatus: ServerStatus = { state: "stopped", owned: false, stopping: false, problem: null };

/** The supervisor's state machine, kept pure so every transition is testable. */
// complexity-ignore: predates the limit (STD-ARCH-012). Split it before adding branches.
export const nextStatus = (status: ServerStatus, event: ServerEvent): ServerStatus => {
  switch (event.type) {
    case "launching":
      return { state: "starting", owned: true, stopping: false, problem: null };
    case "attached":
      return { state: "running", owned: false, stopping: false, problem: null };
    case "healthy":
      return status.stopping || status.state === "running" ? status : { ...status, state: "running", problem: null };
    case "unreachable":
      if (status.state !== "running" || status.stopping) return status;
      // A server this app attached to just goes away; an owned one may still be alive but stuck.
      return status.owned
        ? { ...status, state: "error", problem: "The server stopped answering." }
        : { ...status, state: "stopped" };
    case "startFailed":
      return { ...status, state: "error", problem: event.problem };
    case "stopping":
      return status.owned && status.state !== "stopped" ? { ...status, stopping: true } : status;
    case "exited":
      if (!status.owned) return status;
      return status.stopping || status.state === "error"
        ? { ...status, state: status.state === "error" ? "error" : "stopped", stopping: false }
        : {
            ...status,
            state: "error",
            stopping: false,
            problem: `The server stopped unexpectedly (exit code ${event.code}).`,
          };
  }
};

/** The parts of Electron's `UtilityProcess` the supervisor uses. */
export interface ServerProcess {
  readonly pid: number | undefined;
  /** Asks the process to stop; SIGTERM on POSIX. */
  kill(): boolean;
  once(event: "exit", listener: (code: number) => void): unknown;
}

/** Raised when a launched server never answered. */
export class StartTimedOut extends Error {}

export interface SupervisorOptions {
  readonly apiUrl: string;
  readonly launch: () => Promise<ServerProcess>;
  /**
   * Asks what answers on the port: nothing, or this installation's server. Throws for anything
   * else, such as another program or another installation's server, which the app never uses.
   */
  readonly probe: () => Promise<"none" | "ours">;
  readonly startTimeoutMs?: number;
  readonly stopTimeoutMs?: number;
  /** Ends a process that ignored the graceful stop. */
  readonly forceKill?: (pid: number) => void;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class ServerSupervisor {
  #status: ServerStatus = initialStatus;
  #process: ServerProcess | null = null;
  #exited: Promise<void> = Promise.resolve();
  #starting: Promise<void> | null = null;
  #stopping: Promise<void> | null = null;
  #shuttingDown = false;
  readonly #listeners = new Set<(status: ServerStatus) => void>();

  constructor(private readonly options: SupervisorOptions) {}

  get status() {
    return this.#status;
  }

  /** True while a server this app launched is still alive, even when it does not answer. */
  get ownsProcess() {
    return this.#process !== null;
  }

  onChange(listener: (status: ServerStatus) => void) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #emit(event: ServerEvent) {
    const next = nextStatus(this.#status, event);
    if (next === this.#status) return;
    this.#status = next;
    for (const listener of this.#listeners) listener(next);
  }

  /**
   * Connects to a running server, or launches one owned by this app and waits until it answers.
   * Calls made while a start is in progress share it, so only one server is ever launched. Rejects
   * when no server of this installation could be reached, after reporting it as an error.
   */
  start() {
    this.#starting ??= this.#start().finally(() => {
      this.#starting = null;
    });
    return this.#starting;
  }

  async #start() {
    if (this.#status.state === "running") return;
    // An owned server that stopped answering is stopped before another takes its port.
    if (this.#process) await this.stop();
    if (this.#shuttingDown) return;
    if ((await this.#probe()) === "ours") {
      this.#emit({ type: "attached" });
      return;
    }
    // Quit may have come while the port was checked; never launch a server the app is about to leave.
    if (this.#shuttingDown) return;
    this.#emit({ type: "launching" });
    let child: ServerProcess;
    try {
      child = await this.options.launch();
    } catch (error) {
      this.#emit({ type: "startFailed", problem: `The server could not be launched: ${String(error)}` });
      throw error;
    }
    this.#process = child;
    this.#exited = new Promise((resolve) => {
      child.once("exit", (code) => {
        resolve();
        // A server that was replaced no longer speaks for the current one.
        if (this.#process !== child) return;
        this.#process = null;
        this.#emit({ type: "exited", code });
      });
    });
    const deadline = Date.now() + (this.options.startTimeoutMs ?? 20_000);
    while (Date.now() < deadline && this.#process === child && !this.#shuttingDown) {
      let found: "none" | "ours";
      try {
        found = await this.#probe();
      } catch (error) {
        await this.stop();
        throw error;
      }
      if (found === "ours") {
        this.#emit({ type: "healthy" });
        return;
      }
      await sleep(250);
    }
    if (this.#status.state === "starting" && !this.#shuttingDown) {
      const problem = `The server did not start on ${this.options.apiUrl}.`;
      this.#emit({ type: "startFailed", problem });
      // A server that never answered is of no use; do not leave it running in the background.
      await this.stop();
      throw new StartTimedOut(problem);
    }
  }

  /** Probes the port, reporting a stranger on it as the error. */
  async #probe() {
    try {
      return await this.options.probe();
    } catch (error) {
      this.#emit({ type: "startFailed", problem: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }

  /** Checks the server once; call it on an interval so the menu-bar icon notices a server that went away. */
  async check() {
    const { state, stopping } = this.#status;
    // An owned server that stopped answering is checked too, so it shows as running once it recovers.
    if (stopping || (state !== "running" && !(state === "error" && this.#process))) return;
    const found = await this.options.probe().catch(() => "none" as const);
    this.#emit({ type: found === "ours" ? "healthy" : "unreachable" });
  }

  /**
   * Stops a server this app launched: asks it to stop, waits for it to exit and kills it after the
   * timeout. A server this app attached to keeps running. Calls made while a stop is in progress
   * share it.
   */
  stop() {
    this.#stopping ??= this.#stop().finally(() => {
      this.#stopping = null;
    });
    return this.#stopping;
  }

  /**
   * Stops for good, for Quit: cancels a start in progress, including a restart still waiting for the
   * old server to stop, and stops whatever server this app owns. No server is launched afterwards.
   */
  async shutdown() {
    this.#shuttingDown = true;
    await this.stop();
    await this.#starting;
    // A start that launched a server before it saw the shutdown leaves that server to stop here.
    await this.stop();
  }

  async #stop() {
    const child = this.#process;
    if (!child) return;
    const exited = this.#exited;
    this.#emit({ type: "stopping" });
    child.kill();
    const timeoutMs = this.options.stopTimeoutMs ?? 10_000;
    const exitedInTime = await Promise.race([exited.then(() => true), sleep(timeoutMs).then(() => false)]);
    if (!exitedInTime && child.pid !== undefined) {
      (this.options.forceKill ?? ((pid) => process.kill(pid, "SIGKILL")))(child.pid);
      await Promise.race([exited, sleep(2_000)]);
    }
  }
}
