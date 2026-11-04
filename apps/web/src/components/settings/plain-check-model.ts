import type { GitHubStatus } from "@hobbots/api";
import type { RemoteAccessStatus, RuntimeHealth, RuntimeKind } from "@hobbots/domain";
import { formatCount, plural } from "../../lib/format.ts";
import { PROVIDER_NAMES, PROVIDERS } from "../../lib/providers.ts";
import { messages } from "./messages.ts";
import { providerState, unreachable } from "./overview-model.ts";

const copy = messages.check.lines;

/** How a check came out: it works, it is off by choice, it needs a look, or it is broken. */
export type CheckTone = "ok" | "off" | "warn" | "broken";

/** One line of the plain check, and where to go when it needs you. */
export interface CheckLine {
  readonly key: string;
  readonly tone: CheckTone;
  readonly text: string;
  /** The Inbox, for stuck work you retry or dismiss there. */
  readonly inbox?: true;
}

/** What the plain check reads; anything still loading is undefined. */
export interface CheckInput {
  readonly runtimes: ReadonlyArray<RuntimeHealth> | undefined;
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
  if (connected.length === 0) return [{ key: "ai", tone: "broken", text: copy.noAi }];
  return connected.map((runtime): CheckLine => {
    const name = PROVIDER_NAMES[runtime];
    const state = providerState(input.runtimes?.find((entry) => entry.runtime === runtime));
    return state === null
      ? { key: runtime, tone: "ok", text: copy.answers({ name }) }
      : { key: runtime, tone: "broken", text: copy.cannotThink({ name, state }) };
  });
};

/** The sandbox counts as working once a connected, ready provider verified it on this hub. */
const sandboxLine = (input: CheckInput): CheckLine => {
  const ready = (input.runtimes ?? []).filter(
    (health) => input.connected?.includes(health.runtime) && health.availability === "ready",
  );
  const verified = ready.some((health) => health.enforcement.processSandbox.status === "verified");
  return verified
    ? { key: "sandbox", tone: "ok", text: copy.sandbox }
    : { key: "sandbox", tone: "warn", text: copy.noSandbox };
};

const foldersLine = (folders: number): CheckLine =>
  folders === 0
    ? { key: "folders", tone: "off", text: copy.noFolders }
    : {
        key: "folders",
        tone: "ok",
        text: plural(folders, { one: copy.oneFolder, other: copy.folders({ count: formatCount(folders) }) }),
      };

const githubLine = (status: GitHubStatus | undefined): CheckLine =>
  status?._tag === "Connected" || status?._tag === "Environment"
    ? { key: "github", tone: "ok", text: copy.github }
    : { key: "github", tone: "off", text: copy.noGithub };

const remoteLine = (remote: RemoteAccessStatus | undefined): CheckLine => {
  if (remote === undefined || !remote.enabled) return { key: "remote", tone: "off", text: copy.remoteOff };
  if (remote.paused) return { key: "remote", tone: "warn", text: copy.remotePaused };
  if (unreachable(remote)) return { key: "remote", tone: "broken", text: copy.remoteUnreachable };
  return { key: "remote", tone: "ok", text: copy.remoteOn };
};

const stuckLine = (stuck: number): CheckLine =>
  stuck === 0
    ? { key: "stuck", tone: "ok", text: copy.nothingStuck }
    : {
        key: "stuck",
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
  ...(input.folders === undefined ? [] : [foldersLine(input.folders)]),
  githubLine(input.github),
  // A connected desktop's hub sets remote access, so this Mac does not check it.
  ...(input.remote === null ? [] : [remoteLine(input.remote)]),
  ...(input.stuck === undefined ? [] : [stuckLine(input.stuck)]),
];
