import type { TailscaleState } from "@hobbots/domain";

/**
 * What the desktop app's setup bridge hands setup's local pages (ADR 025): the hubs found on the
 * tailnet, why an address was refused, the waiting screen and how Connect ended. The main process
 * checks the address, pairs and keeps the token, so none of it carries the token or the pairing
 * secret.
 */

/** Tailscale on this computer, while it is not ready. */
export type TailscaleNotRunning = Exclude<TailscaleState, "running">;

/** A hub found on the tailnet, as Connect lists it: by the computer's Tailscale name first. */
export interface FoundHubView {
  /** The computer as Tailscale names it: the first label of its MagicDNS name. */
  readonly computer: string;
  /** The address Connect uses for it, `http://<MagicDNS name>:4317`. */
  readonly address: string;
  /** The name the hub reports about itself, shown only beside the computer's. */
  readonly hubName: string | null;
  readonly version: string;
  /** Whether this app can connect to it, or which side needs an update. */
  readonly support: "supported" | "hubOlder" | "appOlder";
}

/** What Connect lists: the hubs found, or why this computer's Tailscale could not be read. */
export type HubListView =
  | { readonly kind: "hubs"; readonly hubs: ReadonlyArray<FoundHubView> }
  | { readonly kind: "tailscale"; readonly state: TailscaleNotRunning };

/** Why a typed address was refused before any request, with the computer named where there is one. */
export type AddressRefusal =
  | {
      readonly reason: "Empty" | "Malformed" | "Loopback" | "LocalNetwork" | "Public" | "NotOnTailnet" | "ThisComputer";
    }
  | { readonly reason: "TailscaleNotReady"; readonly state: TailscaleNotRunning }
  | { readonly reason: "NotYours"; readonly computer: string };

/** The waiting screen: the computer as Tailscale names it, its owner, and the code its prompt shows. */
export interface WaitingView {
  readonly computer: string;
  /** The Tailscale account the computer belongs to; null for a tagged node. */
  readonly owner: string | null;
  /** The name the hub reports about itself, shown only beside the computer's. */
  readonly hubName: string;
  readonly code: string;
  readonly expiresAt: string;
}

/** How a pairing that did not connect ended, with what the page needs to say why. */
export type PairingEnd =
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
  | { readonly kind: "noKeychain"; readonly message: string };

/** How Connect ended: allowed, cancelled, refused before any request, or ended on the hub's side. */
export type ConnectEnd =
  | { readonly kind: "allowed"; readonly computer: string }
  | { readonly kind: "cancelled" }
  | { readonly kind: "refused"; readonly refusal: AddressRefusal }
  | { readonly kind: "ended"; readonly computer: string; readonly address: string; readonly outcome: PairingEnd };
