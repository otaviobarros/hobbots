import { Effect } from "effect";
import { claimHubPresence } from "../src/hub-presence.ts";

// Claims a data folder as a hub's start does, for the concurrent start case in hub-presence.test.ts:
// `presence-claimant.ts <data folder> <port>`. It prints `ready`, claims on a line from its input,
// then prints `claimed <pid>` or `refused <reason>`, and
// once it holds the folder it stays alive, as a hub would, until the test stops it.

const [dataDir = "", port = "0"] = process.argv.slice(2);

// All claimants start their claim at once: each waits until the test writes a line to all of them.
process.stdout.write("ready\n");
process.stdin.once("data", () =>
  Effect.runPromise(claimHubPresence(dataDir, Number(port))).then(
    () => {
      process.stdout.write(`claimed ${process.pid}\n`);
      setInterval(() => {}, 60_000);
    },
    (error: unknown) => {
      process.stdout.write(`refused ${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(0);
    },
  ),
);
