import type { Server } from "node:http";
import { createServer as createNetServer, type Server as NetServer, type Socket } from "node:net";
import { Context, Effect, Layer } from "effect";
import { Tailscale } from "./tailscale.ts";

/**
 * Where the hub listens (ADR 021): `127.0.0.1` at its port through the HTTP server, `::1` beside
 * it, and each tailnet address while remote access is on. Every listener hands its connections to
 * the one HTTP server, so every route, and every check on a route, serves them all alike. The hub
 * never listens on `0.0.0.0`, `::` or any other interface.
 */

/** Connections a tailnet listener accepted. A request on one is a tailnet request, never a local one. */
const tailnetSockets = new WeakSet<Socket>();

/** Whether a connection came in on a tailnet listener. */
export const arrivedOnTailnet = (socket: Socket | undefined): boolean =>
  socket !== undefined && tailnetSockets.has(socket);

/** A tailnet address the hub could not listen on, in the system's words. */
export interface ListenFailure {
  readonly address: string;
  readonly detail: string;
}

export class HubListeners extends Context.Service<
  HubListeners,
  {
    /** The port every listener uses. */
    readonly port: Effect.Effect<number>;
    /**
     * Moves the loopback listeners to `port` and closes the tailnet ones, which the caller opens
     * again at the new port. Connections already open stay, on loopback and on the tailnet, so
     * clients hear where the hub went. Fails with the system's words when the port cannot be opened
     * on loopback, and then changes nothing.
     */
    readonly movePort: (port: number) => Effect.Effect<void, string>;
    /**
     * Listens on exactly these tailnet addresses: opens the new ones and closes the others, with
     * every connection they accepted. Only addresses in Tailscale's ranges are opened. Answers the
     * addresses it listens on, and why it could not open the rest.
     */
    readonly listenOnTailnet: (addresses: ReadonlyArray<string>) => Effect.Effect<{
      readonly listening: ReadonlyArray<string>;
      readonly failed: ReadonlyArray<ListenFailure>;
    }>;
  }
>()("@hobbots/server/HubListeners") {}

/** A socket server on one address, handing what it accepts to `accept`, or the error it failed with. */
const listen = (host: string, port: number, accept: (socket: Socket) => void) =>
  Effect.callback<NetServer, NodeJS.ErrnoException>((resume) => {
    const relay = createNetServer(accept);
    relay.once("error", (error: NodeJS.ErrnoException) => resume(Effect.fail(error)));
    relay.listen({ host, port, ipv6Only: host.includes(":") }, () => resume(Effect.succeed(relay)));
  });

const close = (relay: NetServer) => Effect.callback<void>((resume) => void relay.close(() => resume(Effect.void)));

/**
 * Stops a listener taking connections. Node calls back only once every connection it accepted has
 * ended, and those belong to the HTTP server, so this does not wait for that.
 */
const stopListening = (relay: NetServer) => Effect.sync(() => void relay.close());

const describe = (error: NodeJS.ErrnoException) =>
  error.code === "EADDRINUSE"
    ? "another program is using the port"
    : error.code === "EADDRNOTAVAIL"
      ? "the address is not on this computer"
      : error.message;

// A host with IPv6 turned off still serves on 127.0.0.1.
const noIpv6 = (error: NodeJS.ErrnoException) => error.code === "EADDRNOTAVAIL" || error.code === "EAFNOSUPPORT";

/**
 * The hub's listeners around its HTTP server, which already listens on `127.0.0.1` at `port`. A
 * tailnet listener accepts only peers from Tailscale's addresses: any other connection is closed at once.
 */
export const HubListenersLive = (server: Server, initialPort: number) =>
  Layer.effect(
    HubListeners,
    Effect.gen(function* () {
      const { isTailnetAddress } = yield* Tailscale;
      let port = initialPort;
      const hand = (socket: Socket) => server.emit("connection", socket);
      // `localhost` works whichever loopback address the browser resolves it to.
      const ipv6Loopback = (at: number) =>
        listen("::1", at, hand).pipe(
          Effect.catchIf(noIpv6, () => Effect.succeed(undefined)),
          Effect.mapError(describe),
        );
      let loopback6 = yield* ipv6Loopback(port).pipe(Effect.orDie);
      // A tailnet address's listener, and the connections it accepted. The connections outlive the
      // listener when the port moves, so a client hears where the hub went, and close with the
      // address when Tailscale no longer gives it.
      const relays = new Map<string, NetServer>();
      const connections = new Map<string, Set<Socket>>();
      const connectionsAt = (address: string) => {
        const known = connections.get(address);
        if (known !== undefined) return known;
        const created = new Set<Socket>();
        connections.set(address, created);
        return created;
      };

      const openTailnet = (address: string) => {
        // Only an address in Tailscale's ranges: never `0.0.0.0`, `::` or another interface's.
        if (!isTailnetAddress(address)) {
          return Effect.fail<NodeJS.ErrnoException>(new Error("the address is not a Tailscale address"));
        }
        return listen(address, port, (socket) => {
          if (!isTailnetAddress(socket.remoteAddress ?? "")) {
            socket.destroy();
            return;
          }
          const sockets = connectionsAt(address);
          tailnetSockets.add(socket);
          sockets.add(socket);
          socket.once("close", () => sockets.delete(socket));
          hand(socket);
        });
      };
      const closeRelay = (address: string) =>
        Effect.suspend(() => {
          const relay = relays.get(address);
          relays.delete(address);
          return relay === undefined ? Effect.void : stopListening(relay);
        });
      const dropTailnet = (address: string) =>
        Effect.suspend(() => {
          for (const socket of connections.get(address) ?? []) socket.destroy();
          connections.delete(address);
          return closeRelay(address);
        });
      const tailnetAddresses = () => [...new Set([...relays.keys(), ...connections.keys()])];

      yield* Effect.addFinalizer(() =>
        Effect.andThen(
          Effect.suspend(() => Effect.forEach(tailnetAddresses(), dropTailnet, { discard: true })),
          loopback6 === undefined ? Effect.void : stopListening(loopback6),
        ),
      );

      // Listens on `at` once more, answering why it could not.
      const relisten = (at: number) =>
        Effect.callback<void, NodeJS.ErrnoException>((resume) => {
          const failed = (error: NodeJS.ErrnoException) => {
            server.off("listening", listening);
            resume(Effect.fail(error));
          };
          const listening = () => {
            server.off("error", failed);
            resume(Effect.void);
          };
          server.once("error", failed);
          server.once("listening", listening);
          server.listen({ host: "127.0.0.1", port: at });
        });

      const moveMain = (to: number) =>
        Effect.gen(function* () {
          // A port another program holds fails here, while the server still listens where it was.
          yield* listen("127.0.0.1", to, (socket) => socket.destroy()).pipe(Effect.flatMap(close));
          const from = port;
          // Closing stops new connections only; those already open stay with the server.
          server.close();
          yield* relisten(to).pipe(
            Effect.catch((error) =>
              relisten(from).pipe(
                Effect.catch((again) =>
                  Effect.logError(`Could not listen on 127.0.0.1:${from} again: ${describe(again)}`),
                ),
                Effect.andThen(Effect.fail(error)),
              ),
            ),
          );
        }).pipe(Effect.mapError(describe));

      return HubListeners.of({
        port: Effect.sync(() => port),
        movePort: (to) =>
          Effect.gen(function* () {
            if (to === port) return;
            // The IPv6 listener first: when the port is taken there, nothing has moved yet.
            const next6 = yield* ipv6Loopback(to);
            yield* moveMain(to).pipe(Effect.tapError(() => (next6 === undefined ? Effect.void : stopListening(next6))));
            if (loopback6 !== undefined) yield* stopListening(loopback6);
            loopback6 = next6;
            yield* Effect.forEach([...relays.keys()], closeRelay, { discard: true });
            port = to;
          }),
        listenOnTailnet: (addresses) =>
          Effect.gen(function* () {
            const wanted = new Set(addresses);
            yield* Effect.forEach(
              tailnetAddresses().filter((address) => !wanted.has(address)),
              dropTailnet,
              { discard: true },
            );
            const failed: Array<ListenFailure> = [];
            for (const address of wanted) {
              if (relays.has(address)) continue;
              const opened = yield* openTailnet(address).pipe(Effect.result);
              if (opened._tag === "Success") relays.set(address, opened.success);
              else failed.push({ address, detail: describe(opened.failure) });
            }
            return { listening: [...relays.keys()], failed };
          }),
      });
    }),
  );
