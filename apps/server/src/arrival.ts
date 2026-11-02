import type { Socket } from "node:net";
import { NodeHttpServerRequest } from "@effect/platform-node";
import type { HttpServerRequest } from "effect/http";

/**
 * Which listener a connection arrived on (ADR 021). Every listener hands its connections to the one
 * HTTP server, so the listener marks each connection it accepts, and the checks read the mark.
 */

/** Connections a tailnet listener accepted. A request on one is a tailnet request, never a local one. */
const tailnetSockets = new WeakSet<Socket>();

/**
 * Connections the serve listener accepted: those `tailscale serve` forwards over HTTPS. They come
 * from loopback, but a request on one is a tailnet request, never a local one.
 */
const servedSockets = new WeakSet<Socket>();

export const markTailnet = (socket: Socket) => void tailnetSockets.add(socket);

export const markServed = (socket: Socket) => void servedSockets.add(socket);

/** Whether a connection came in on a tailnet listener. */
export const arrivedOnTailnet = (socket: Socket | undefined): boolean =>
  socket !== undefined && tailnetSockets.has(socket);

/** Whether a connection came in on the serve listener, through `tailscale serve`. */
export const arrivedThroughServe = (socket: Socket | undefined): boolean =>
  socket !== undefined && servedSockets.has(socket);

/**
 * The connection's socket, when the request came over Node's HTTP server; a request from a web
 * handler, as in tests, has none and counts as local.
 */
export const socketOf = (request: HttpServerRequest.HttpServerRequest): Socket | undefined =>
  (NodeHttpServerRequest.toIncomingMessage(request) as { readonly socket?: Socket } | undefined)?.socket;

/** Whether a request came through `tailscale serve`, so its page is on the hub's HTTPS address. */
export const throughServe = (request: HttpServerRequest.HttpServerRequest): boolean =>
  arrivedThroughServe(socketOf(request));
