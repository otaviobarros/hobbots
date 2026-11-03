/**
 * A connected desktop following its hub to a new address on the same computer (ADR 025): a port the
 * hub moved to while connected, HTTPS turned off under an HTTPS address, or an address the user types
 * after the hub moved while this app was away. The token stays, since ADR 021 binds it to the node
 * and not to the port, so none of these needs a new approval. Electron stays out of this file.
 */
import { type AddressRefused, resolveHubAddress } from "@hobbots/server/hub-discovery";
import type { TailnetSnapshot } from "@hobbots/server/tailscale";
import { Result } from "effect";
import { askHub, hubOrigins } from "./hub-connection.ts";
import type { HubChange } from "./hub-events-model.ts";
import { shortNodeName } from "./menu-bar-model.ts";
import { messages } from "./messages.ts";

const copy = messages.changeAddress;

export type RemoteAccessChange = Extract<HubChange, { readonly _tag: "RemoteAccess" }>;

/**
 * The address to move to after the hub's remote access changed, or null to stay. An HTTP address
 * follows the hub's port; an HTTPS address stays while the hub serves HTTPS and falls back to the
 * HTTP address once it does not.
 */
export const followedAddress = (address: string, change: RemoteAccessChange): string | null => {
  const origins = hubOrigins(address);
  if (origins === undefined) return null;
  const httpAddress = `${origins.http}:${change.port}`;
  if (origins.origin.startsWith("https:")) return change.servesHttps === false ? httpAddress : null;
  return origins.origin === httpAddress ? null : httpAddress;
};

/**
 * Where a window goes once the hub's remote access changed, or null to leave it: a page on the hub's
 * HTTPS address, which the hub may have redirected it to from an HTTP address, moves to the same
 * path on the HTTP address once HTTPS no longer answers. The stored address may still be the HTTP
 * one, so the window's own address decides, not the stored one.
 */
export const windowAfterRemoteAccess = (url: string, address: string, change: RemoteAccessChange): string | null => {
  const origins = hubOrigins(address);
  if (origins === undefined || change.servesHttps !== false) return null;
  let page: URL;
  try {
    page = new URL(url);
  } catch {
    return null;
  }
  if (page.origin !== origins.https) return null;
  return `${origins.http}:${change.port}${page.pathname}${page.search}${page.hash}`;
};

/** What became of an address the user typed: the hub's new address, or why it was not taken. */
export type AddressChange =
  | { readonly _tag: "Moved"; readonly address: string }
  | { readonly _tag: "Refused"; readonly message: string };

const refusalMessage = (refused: AddressRefused): string => {
  switch (refused._tag) {
    case "Empty":
      return copy.empty;
    case "Malformed":
      return copy.malformed;
    case "TailscaleNotReady":
      return copy.tailscaleOff;
    case "Loopback":
    case "LocalNetwork":
    case "Public":
      return copy.notTailnet;
    case "NotOnTailnet":
      return copy.notOnTailnet;
    case "ThisComputer":
      return copy.thisComputer;
    case "NotYours":
      return copy.otherComputer({ computer: refused.node.nodeName });
  }
};

export interface AddressChangeOptions {
  readonly typed: string;
  /** The hub's node, pinned after Allow: the new address must be on it. */
  readonly nodeId: string;
  readonly nodeName: string;
  readonly snapshot: TailnetSnapshot;
  readonly fetch: typeof fetch;
}

/**
 * Checks a typed address before the app moves to it: it must name the same computer as Tailscale
 * names it, and Hobbots must answer there with a connect protocol this app supports. Another
 * computer is refused, since its hub never allowed this device; using it means disconnecting first.
 */
export const checkNewAddress = async (options: AddressChangeOptions): Promise<AddressChange> => {
  const resolved = resolveHubAddress(options.typed, options.snapshot);
  if (Result.isFailure(resolved)) return { _tag: "Refused", message: refusalMessage(resolved.failure) };
  const { node, origin } = resolved.success;
  if (node.nodeId !== options.nodeId) {
    return { _tag: "Refused", message: copy.otherComputer({ computer: node.nodeName }) };
  }
  const answer = await askHub(origin, options.fetch, options.nodeName);
  switch (answer.kind) {
    case "ready":
      return { _tag: "Moved", address: origin };
    case "noAnswer":
      return { _tag: "Refused", message: copy.noAnswer({ address: origin }) };
    case "notHobbots":
      return { _tag: "Refused", message: messages.connection.notHobbots({ address: origin }) };
    case "unsupported":
      return {
        _tag: "Refused",
        message:
          answer.side === "hubOlder"
            ? messages.connection.hubOlderDetail({ hub: shortNodeName(node.nodeName) })
            : messages.connection.appOlderDetail,
      };
  }
};
