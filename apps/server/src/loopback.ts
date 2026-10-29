import type { Server } from "node:http";
import { createServer as createNetServer } from "node:net";
import { Effect, Layer } from "effect";

/**
 * Also accepts connections on IPv6 loopback (::1) for an HTTP server that listens on 127.0.0.1,
 * so `localhost` works whichever address the browser resolves it to. Node's HTTP server listens on
 * one address, so a second socket server hands its connections to the same HTTP server.
 */
export const IPv6Loopback = (server: Server, port: number) =>
  Layer.effectDiscard(
    Effect.acquireRelease(
      Effect.callback<ReturnType<typeof createNetServer> | undefined>((resume) => {
        const relay = createNetServer((socket) => server.emit("connection", socket));
        relay.once("error", (error: NodeJS.ErrnoException) => {
          // A host with IPv6 turned off still serves on 127.0.0.1.
          if (error.code === "EADDRNOTAVAIL" || error.code === "EAFNOSUPPORT") resume(Effect.succeed(undefined));
          else resume(Effect.die(error));
        });
        relay.listen({ host: "::1", port, ipv6Only: true }, () => resume(Effect.succeed(relay)));
      }),
      (relay) =>
        Effect.callback<void>((resume) => {
          if (relay) relay.close(() => resume(Effect.void));
          else resume(Effect.void);
        }),
    ),
  );
