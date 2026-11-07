import type { GitHubStatus } from "@hobbots/api";
import type { MemoryEngineHealth, RemoteAccessStatus, RuntimeHealth, RuntimeKind } from "@hobbots/domain";
import { formatCount, plural } from "../../lib/format.ts";
import { PROVIDER_NAMES, PROVIDERS } from "../../lib/providers.ts";
import { messages } from "./messages.ts";
import { providerState, unreachable } from "./overview-model.ts";

const copy = messages.check.lines;
const names = messages.check.names;

/** How a check came out: it works, it is off by choice, it needs a look, or it is broken. */
export type CheckTone = "ok" | "off" | "warn" | "broken";

/** The read a line comes from, so the line can say it is checking while that read runs. */
export type CheckSource = "runtimes" | "memory" | "setup" | "github" | "remote" | "blockers";

/** One line of the plain check, and where to go when it needs you. */
export interface CheckLine {
  readonly key: string;
  /** What the line checks, shown with "Checking…" while its read runs. */
  readonly name: string;
  readonly source: CheckSource;
  readonly tone: CheckTone;
  readonly text: string;
  /** The Inbox, for stuck work you retry or dismiss there. */
  readonly inbox?: true;
}

/** What the plain check reads; anything still loading is undefined. */
export interface CheckInput {
  readonly runtimes: ReadonlyArray<RuntimeHealth> | undefined;
  /** The memory engine's health; null on a hub that runs none. */
  readonly memory: MemoryEngineHealth | null | undefined;
  readonly connected: ReadonlyArray<RuntimeKind> | undefined;
  readonly folders: number | undefined;
  readonly github: GitHubStatus | undefined;
  /** Null on a connected desktop, whose hub sets remote access. */
  readonly remote: RemoteAccessStatus | null | undefined;
  /** Stuck work, counted as the Inbox counts it. */
  readonly stuck: number | undefined;
}

const providerLines = (input: CheckInput): ReadonlyArray<CheckLine> => {
  const connected = PROVIDERS.filter((runtime) => input.connected?.includes(runtime));
  if (connected.length === 0) return [{ key: "ai", name: names.ai, source: "setup", tone: "broken", text: copy.noAi }];
  return connected.map((runtime): CheckLine => {
    const name = PROVIDER_NAMES[runtime];
    const state = providerState(input.runtimes?.find((entry) => entry.runtime === runtime));
    const base = { key: runtime, name, source: "runtimes" } as const;
    return state === null
      ? { ...base, tone: "ok", text: copy.answers({ name }) }
      : { ...base, tone: "broken", text: copy.cannotThink({ name, state }) };
  });
};

/** The sandbox counts as working once a connected, ready provider verified it on this hub. */
const sandboxLine = (input: CheckInput): CheckLine => {
  const ready = (input.runtimes ?? []).filter(
    (health) => input.connected?.includes(health.runtime) && health.availability === "ready",
  );
  const verified = ready.some((health) => health.enforcement.processSandbox.status === "verified");
  const base = { key: "sandbox", name: names.sandbox, source: "runtimes" } as const;
  return verified ? { ...base, tone: "ok", text: copy.sandbox } : { ...base, tone: "warn", text: copy.noSandbox };
};

/** The memory engine (ADR 028): running, starting, off by choice, or unable to start in this copy. */
const memoryLine = (health: MemoryEngineHealth): CheckLine => {
  const base = { key: "memory", name: names.memory, source: "memory" } as const;
  switch (health.state) {
    case "running":
      return { ...base, tone: "ok", text: copy.memoryRunning };
    case "starting":
      return { ...base, tone: "warn", text: copy.memoryStarting };
    case "restarting":
      return { ...base, tone: "warn", text: copy.memoryRestarting };
    case "off":
      if (health.offReason === "missing") return { ...base, tone: "broken", text: copy.memoryMissing };
      if (health.offReason === "checksum") return { ...base, tone: "broken", text: copy.memoryChecksum };
      return { ...base, tone: "off", text: copy.memoryOff };
  }
};

const foldersLine = (folders: number): CheckLine =>
  folders === 0
    ? { key: "folders", name: names.folders, source: "setup", tone: "off", text: copy.noFolders }
    : {
        key: "folders",
        name: names.folders,
        source: "setup",
        tone: "ok",
        text: plural(folders, { one: copy.oneFolder, other: copy.folders({ count: formatCount(folders) }) }),
      };

const githubLine = (status: GitHubStatus | undefined): CheckLine => {
  const base = { key: "github", name: names.github, source: "github" } as const;
  return status?._tag === "Connected" || status?._tag === "Environment"
    ? { ...base, tone: "ok", text: copy.github }
    : { ...base, tone: "off", text: copy.noGithub };
};

const remoteLine = (remote: RemoteAccessStatus | undefined): CheckLine => {
  const base = { key: "remote", name: names.remote, source: "remote" } as const;
  if (remote === undefined || !remote.enabled) return { ...base, tone: "off", text: copy.remoteOff };
  if (remote.paused) return { ...base, tone: "warn", text: copy.remotePaused };
  if (unreachable(remote)) return { ...base, tone: "broken", text: copy.remoteUnreachable };
  return { ...base, tone: "ok", text: copy.remoteOn };
};

const stuckLine = (stuck: number): CheckLine =>
  stuck === 0
    ? { key: "stuck", name: names.stuck, source: "blockers", tone: "ok", text: copy.nothingStuck }
    : {
        key: "stuck",
        name: names.stuck,
        source: "blockers",
        tone: "broken",
        text: plural(stuck, { one: copy.oneStuck, other: copy.stuck({ count: formatCount(stuck) }) }),
        inbox: true,
      };

/**
 * The plain check in Help and about: each part of Hobbots in one plain sentence, from the hub's own
 * records. Stuck work is counted as the Inbox counts it, so both always agree.
 */
export const checkLines = (input: CheckInput): ReadonlyArray<CheckLine> => [
  ...providerLines(input),
  sandboxLine(input),
  // A hub that runs no memory engine, or whose answer is still on its way, shows no line for it.
  ...(input.memory === undefined || input.memory === null ? [] : [memoryLine(input.memory)]),
  ...(input.folders === undefined ? [] : [foldersLine(input.folders)]),
  githubLine(input.github),
  // A connected desktop's hub sets remote access, so this Mac does not check it.
  ...(input.remote === null ? [] : [remoteLine(input.remote)]),
  ...(input.stuck === undefined ? [] : [stuckLine(input.stuck)]),
];
