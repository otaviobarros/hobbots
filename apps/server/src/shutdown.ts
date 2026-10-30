import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { Effect, Layer } from "effect";
import { EventBus } from "./event-bus.ts";

/**
 * Lets the hub stop at once while clients are connected. The HTTP server waits for every
 * connection to close before it stops, up to a 20 second graceful shutdown timeout, and a browser
 * window holds several open: its event stream, which never ends on its own, connections kept alive
 * after a request, and spare ones it opened ahead of time and may never use.
 *
 * Provide the HTTP server to this layer, so its finalizer runs before the server starts to wait:
 * it ends the event streams, then closes each connection as soon as no request is in progress on
 * it. A request that is still running finishes first.
 */
export const StopWithoutWaitingForClients = (server: Server) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const bus = yield* EventBus;
      // Requests in progress on each open connection.
      const connections = new Map<Socket, number>();
      let stopping = false;
      const endIfIdle = (socket: Socket) => {
        if (stopping && connections.get(socket) === 0) socket.destroy();
      };
      server.on("connection", (socket: Socket) => {
        connections.set(socket, 0);
        socket.once("close", () => connections.delete(socket));
        // A browser can open one more once its event stream ends, and the IPv6 relay still accepts.
        endIfIdle(socket);
      });
      const track = (request: IncomingMessage, response: ServerResponse) => {
        const socket = request.socket;
        connections.set(socket, (connections.get(socket) ?? 0) + 1);
        response.once("close", () => {
          connections.set(socket, (connections.get(socket) ?? 1) - 1);
          endIfIdle(socket);
        });
      };
      server.on("request", track);
      // Node emits a request sent with `Expect: 100-continue` here instead of as "request".
      server.on("checkContinue", track);
      yield* Effect.addFinalizer(() =>
        Effect.andThen(
          Effect.sync(() => {
            stopping = true;
            for (const socket of connections.keys()) endIfIdle(socket);
          }),
          bus.close,
        ),
      );
    }),
  );
