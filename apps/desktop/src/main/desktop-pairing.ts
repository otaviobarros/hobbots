/**
 * Pairing as a connected desktop (ADR 021, ADR 025): the main process checks the hub first, asks
 * with `kind: "desktop"` and no `Origin`, keeps the pairing secret in memory and asks every 2
 * seconds until the user answers on the hub. After Allow it pins the hub's node and keeps the token
 * only in the keychain. Electron stays out of this file.
 */
import { OpenedPairing, PairingStatus } from "@hobbots/api";
import { Option, Schema } from "effect";
import { askHub, type HubOrigins, type NodeCheck, type TailnetNode } from "./hub-connection.ts";
import type { HubConnection } from "./settings.ts";

/** How pairing ended, or why it could not start. */
export type PairingOutcome =
  | { readonly kind: "allowed"; readonly connection: HubConnection }
  | { readonly kind: "denied" }
  | { readonly kind: "expired" }
  /** The address is not a tailnet peer of this computer's own Tailscale user. */
  | { readonly kind: "notYourNode" }
  | { readonly kind: "notHobbots" }
  | { readonly kind: "noAnswer" }
  | { readonly kind: "unsupported"; readonly side: "hubOlder" | "appOlder"; readonly version: string }
  /** The hub refused to open a request, such as one from a device that is not the hub owner's. */
  | { readonly kind: "refused"; readonly reason: string }
  | { readonly kind: "throttled"; readonly retryAfterSeconds: number }
  /** The address now belongs to another node than the one the user chose. */
  | { readonly kind: "otherNode" }
  /** The token could not be kept in the keychain, so this computer did not connect. */
  | { readonly kind: "noKeychain"; readonly message: string }
  | { readonly kind: "cancelled" };

/** What the waiting screen shows: the computer as Tailscale names it, and the code its prompt shows. */
interface Waiting {
  readonly node: TailnetNode;
  /** The name the hub reports about itself, shown only beside the node's name. */
  readonly hubName: string;
  readonly code: string;
  readonly expiresAt: string;
}

export interface PairAsDesktopOptions {
  readonly origins: HubOrigins;
  /** What the hub's prompt calls this computer, and what it runs on. */
  readonly device: { readonly name: string; readonly platform: string };
  readonly nodeCheck: NodeCheck;
  /** This computer's own Tailscale user: only that user's nodes are asked. */
  readonly ownLogin: string | null;
  readonly fetch: typeof fetch;
  /** Keeps the token, or fails with why it could not. */
  readonly keepToken: (token: string) => Promise<void>;
  readonly onWaiting: (waiting: Waiting) => void;
  readonly signal?: AbortSignal;
  readonly intervalMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
}

const decodeOpened = Schema.decodeUnknownOption(OpenedPairing);
const decodeStatus = Schema.decodeUnknownOption(PairingStatus);

const wait = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

/** Reads a refusal's body and `Retry-After` into an outcome. */
const refusedOutcome = async (response: Response): Promise<PairingOutcome> => {
  if (response.status === 429) {
    return { kind: "throttled", retryAfterSeconds: Number(response.headers.get("retry-after") ?? 60) || 60 };
  }
  const body = (await response.json().catch(() => null)) as { reason?: unknown } | null;
  return { kind: "refused", reason: typeof body?.reason === "string" ? body.reason : String(response.status) };
};

/** Checks that the address is one of the user's own nodes running a Hobbots this app can use. */
const checkHub = async (
  options: PairAsDesktopOptions,
): Promise<{ readonly node: TailnetNode; readonly name: string } | PairingOutcome> => {
  const node = await options.nodeCheck.nodeOf(options.origins.host);
  if (node === null || node.owner._tag !== "User" || node.owner.login !== options.ownLogin) {
    return { kind: "notYourNode" };
  }
  const answer = await askHub(options.origins.origin, options.fetch, node.nodeName);
  if (answer.kind === "ready") return { node, name: answer.name };
  return answer.kind === "unsupported" ? { kind: "unsupported", side: answer.side, version: answer.version } : answer;
};

/** Opens the request: the hub hands the desktop app its pairing secret in the body. */
const open = async (options: PairAsDesktopOptions) => {
  const response = await options.fetch(`${options.origins.origin}/api/pairing`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...options.device, kind: "desktop" }),
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) return refusedOutcome(response);
  const opened = decodeOpened(await response.json());
  if (Option.isNone(opened) || opened.value.secret === undefined) return { kind: "notHobbots" } as const;
  return { secret: opened.value.secret, status: opened.value.status };
};

/** Asks where the request stands, with the pairing secret as a bearer token. */
const status = async (options: PairAsDesktopOptions, secret: string) => {
  const response = await options.fetch(`${options.origins.origin}/api/pairing`, {
    headers: { authorization: `Bearer ${secret}` },
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) return refusedOutcome(response);
  return Option.getOrElse(decodeStatus(await response.json()), () => ({ kind: "notHobbots" }) as const);
};

/** After Allow: the node must still be the one the user chose, and the token goes only to the keychain. */
const finish = async (
  options: PairAsDesktopOptions,
  hub: { readonly node: TailnetNode; readonly name: string },
  token: string,
  deviceId: string,
): Promise<PairingOutcome> => {
  options.nodeCheck.forget();
  if (!(await options.nodeCheck.isPinned(options.origins.host, hub.node.nodeId))) return { kind: "otherNode" };
  try {
    await options.keepToken(token);
  } catch (error) {
    return { kind: "noKeychain", message: error instanceof Error ? error.message : String(error) };
  }
  return {
    kind: "allowed",
    connection: {
      address: options.origins.origin,
      name: hub.name,
      nodeId: hub.node.nodeId,
      nodeName: hub.node.nodeName,
      deviceId,
    },
  };
};

/** Pairs this computer with the hub at `origins`, as the user chose it. */
export const pairAsDesktop = async (options: PairAsDesktopOptions): Promise<PairingOutcome> => {
  const sleep = options.sleep ?? wait;
  try {
    const hub = await checkHub(options);
    if ("kind" in hub) return hub;
    const opened = await open(options);
    if ("kind" in opened) return opened;
    options.onWaiting({
      node: hub.node,
      hubName: hub.name,
      code: opened.status.code,
      expiresAt: opened.status.expiresAt,
    });
    for (;;) {
      if (options.signal?.aborted) return { kind: "cancelled" };
      await sleep(options.intervalMs ?? 2000);
      if (options.signal?.aborted) return { kind: "cancelled" };
      // The pairing secret, too, goes only to the node the user chose.
      if (!(await options.nodeCheck.isPinned(options.origins.host, hub.node.nodeId))) return { kind: "otherNode" };
      const now = await status(options, opened.secret);
      if ("kind" in now) return now;
      if (now.state === "denied") return { kind: "denied" };
      if (now.state === "expired") return { kind: "expired" };
      if (now.token !== undefined && now.deviceId !== undefined) return finish(options, hub, now.token, now.deviceId);
    }
  } catch {
    return { kind: "noAnswer" };
  }
};
