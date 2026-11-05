import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checksumLine, ENGINE_BINARY, ENGINE_CHECKSUM, sha256File } from "../src/engine/binary.ts";
import { AI_MEMORY_VERSION } from "../src/engine/release.ts";

/**
 * A stand-in for the ai-memory binary, so the supervisor's tests need no download: it prints the
 * pinned version, and `serve` answers `/healthz` on the address it is given. Each start appends
 * its pid, environment and arguments to `starts.jsonl` in its data folder. A `crash` file there
 * makes the next start exit at once with code 3; a `hang` file makes it stop answering. Its backup
 * route answers the root bearer with `stand-in-backup.tar.gz` from its data folder.
 */
const SCRIPT = `#!${process.execPath}
const { appendFileSync, createReadStream, existsSync } = require("node:fs");
const { createServer } = require("node:http");
const { join } = require("node:path");
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("ai-memory ${AI_MEMORY_VERSION}"); process.exit(0); }
const at = (flag) => args[args.indexOf(flag) + 1];
const data = at("--data-dir");
appendFileSync(join(data, "starts.jsonl"), JSON.stringify({ pid: process.pid, env: process.env, args }) + "\\n");
if (existsSync(join(data, "crash"))) { console.error("stand-in crashed on purpose"); process.exit(3); }
const [host, port] = at("--bind").split(":");
createServer((request, response) => {
  if (existsSync(join(data, "hang"))) return;
  if (request.method === "POST" && request.url === "/admin/backup") {
    const archive = join(data, "stand-in-backup.tar.gz");
    if (request.headers.authorization !== "Bearer " + process.env.AI_MEMORY_AUTH_TOKEN || !existsSync(archive)) {
      response.writeHead(401);
      return response.end();
    }
    response.writeHead(200, { "content-type": "application/gzip" });
    return createReadStream(archive).pipe(response);
  }
  response.writeHead(request.url === "/healthz" ? 200 : 404, { "content-type": "application/json" });
  response.end('{"status":"ok"}');
}).listen(Number(port), host);
process.on("SIGTERM", () => process.exit(0));
`;

/** Writes the stand-in into a new engine folder, with its checksum beside it. */
export const standInEngine = async (): Promise<string> => {
  const folder = mkdtempSync(join(tmpdir(), "hobbots-engine-"));
  mkdirSync(folder, { recursive: true });
  const binary = join(folder, ENGINE_BINARY);
  writeFileSync(binary, SCRIPT);
  chmodSync(binary, 0o755);
  writeFileSync(join(folder, ENGINE_CHECKSUM), checksumLine(await sha256File(binary)));
  return folder;
};
