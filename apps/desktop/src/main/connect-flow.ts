/**
 * Connect, from setup's first screen (ADR 025): find the user's hubs on the tailnet, take the address
 * they typed or picked, pair as a desktop and say how it ended. The answers are what the local pages
 * show, so they carry names and reasons and never the token or the pairing secret. Electron stays out
 * of this file.
 */
import { hostname } from "node:os";
import type { AddressRefusal, ConnectEnd, HubListView, WaitingView } from "@hobbots/api";
import type { AddressRefused } from "@hobbots/server/hub-discovery";
import { pairAsDesktop } from "./desktop-pairing.ts";
import { hubOrigins, makeNodeCheck } from "./hub-connection.ts";
import type { HubConnection } from "./settings.ts";
import type { ThisTailnet } from "./tailnet.ts";

/** The computer a MagicDNS name names, as people call it: its first label. */
const computerName = (nodeName: string) => nodeName.split(".")[0] ?? nodeName;

/** What the hub's prompt calls this computer, as the hub's own window names its own. */
const deviceName = (host: string = hostname()) => `Hobbots on ${host.replace(/\.local$/i, "")}`;
const platformName = (platform: NodeJS.Platform = process.platform) => (platform === "darwin" ? "macOS" : platform);

/** The hubs on the user's own computers, as Connect lists them. */
export const listHubs = async (tailnet: Pick<ThisTailnet, "findHubs">): Promise<HubListView> => {
  const scan = await tailnet.findHubs();
  if (scan._tag === "TailscaleNotReady") {
    // A scan only reports Tailscale as not ready when it is not running.
    return { kind: "tailscale", state: scan.state === "running" ? "notRunning" : scan.state };
  }
  return {
    kind: "hubs",
    hubs: scan.hubs.map((hub) => ({
      computer: computerName(hub.node.nodeName),
      address: hub.origin,
      hubName: hub.name,
      version: hub.version,
      support: hub.support,
    })),
  };
};

const refusalView = (refused: AddressRefused): AddressRefusal => {
  if (refused._tag === "NotYours") return { reason: "NotYours", computer: computerName(refused.node.nodeName) };
  if (refused._tag === "TailscaleNotReady") {
    return { reason: "TailscaleNotReady", state: refused.state === "running" ? "notRunning" : refused.state };
  }
  return { reason: refused._tag };
};

export interface ConnectOptions {
  readonly tailnet: ThisTailnet;
  readonly fetch: typeof fetch;
  /** Keeps the token, or fails with why it could not; never writes a file. */
  readonly keepToken: (token: string) => Promise<void>;
  /** Called once the hub opened the request, with what the waiting screen shows. */
  readonly onWaiting: (waiting: WaitingView) => void;
  /** Deletes a token kept just as the user cancelled, so a cancelled request leaves nothing behind. */
  readonly forgetToken: () => Promise<void>;
  /** Keeps the connection once the hub allowed this computer: from then on it is a connected desktop. */
  readonly onAllowed: (connection: HubConnection) => Promise<void>;
  readonly signal: AbortSignal;
  readonly device?: { readonly name: string; readonly platform: string };
  readonly intervalMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
}

/**
 * Connects this computer to the hub the user typed or picked. The address must name one of the
 * user's own computers on this tailnet, or nothing is sent; then pairing runs as ADR 025 says.
 */
export const connectToHub = async (typed: string, options: ConnectOptions): Promise<ConnectEnd> => {
  const resolved = await options.tailnet.resolveAddress(typed);
  if (options.signal.aborted) return { kind: "cancelled" };
  if (resolved.kind === "refused") return { kind: "refused", refusal: refusalView(resolved.refused) };
  const computer = computerName(resolved.target.node.nodeName);
  const origins = hubOrigins(resolved.target.origin);
  if (origins === undefined) return { kind: "refused", refusal: { reason: "Malformed" } };
  const outcome = await pairAsDesktop({
    origins,
    device: options.device ?? { name: deviceName(), platform: platformName() },
    nodeCheck: makeNodeCheck(options.tailnet),
    ownLogin: await options.tailnet.ownLogin(),
    fetch: options.fetch,
    keepToken: options.keepToken,
    onWaiting: ({ node, hubName, code, expiresAt }) =>
      options.onWaiting({
        computer: computerName(node.nodeName),
        owner: node.owner._tag === "User" ? node.owner.login : null,
        hubName,
        code,
        expiresAt,
      }),
    signal: options.signal,
    ...(options.intervalMs === undefined ? {} : { intervalMs: options.intervalMs }),
    ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
  });
  if (outcome.kind === "allowed") {
    // Cancel pressed while the keychain kept the token still wins: nothing is chosen, and the token goes.
    if (options.signal.aborted) {
      await options.forgetToken().catch(() => undefined);
      return { kind: "cancelled" };
    }
    await options.onAllowed(outcome.connection);
    return { kind: "allowed", computer };
  }
  if (outcome.kind === "cancelled") return outcome;
  return { kind: "ended", computer, address: origins.origin, outcome };
};
