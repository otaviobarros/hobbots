import { Context, type Effect, type Option } from "effect";
import type { HttpServerRequest } from "effect/http";

/** Who owns a tailnet node: a Tailscale user, or the tags a tagged node carries instead. */
export type TailnetOwner =
  | { readonly _tag: "User"; readonly login: string }
  | { readonly _tag: "Tagged"; readonly tags: ReadonlyArray<string> };

/** A Tailscale node, as `tailscale whois` names it (ADR 021). */
export interface TailnetPeer {
  /** Tailscale's stable ID for the node, which a device approved over the tailnet is bound to. */
  readonly nodeId: string;
  /** The node's MagicDNS name, without its trailing dot. */
  readonly nodeName: string;
  readonly owner: TailnetOwner;
}

/**
 * Where a request came from (ADR 021): Some for a tailnet request, with the peer Tailscale names,
 * and None for a local one. Which listener a connection arrived on decides it, not the peer's
 * address: the fake Tailscale serves its tailnet on loopback addresses. A peer Tailscale does not
 * know never gets this far; the hub answers it `403` first.
 */
export class TailnetPeers extends Context.Service<
  TailnetPeers,
  { readonly peerOf: (request: HttpServerRequest.HttpServerRequest) => Effect.Effect<Option.Option<TailnetPeer>> }
>()("@hobbots/server/TailnetPeers") {}
