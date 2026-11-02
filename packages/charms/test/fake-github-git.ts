import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A fake GitHub for Git over HTTP: `git http-backend` behind a server that asks for Basic auth and
 * takes only `token` as the password, as GitHub takes a token. It records every authorization it
 * was sent, so a test can tell which credential reached it.
 */
export interface FakeGitHubGit {
  readonly base: string;
  readonly authorizations: Array<string>;
  /**
   * Drops the connection of every push after this many requests, to stand in for a lost answer:
   * `before` GitHub takes it in, or `after` it has applied the push.
   */
  drop: { readonly after: number; readonly when: "before" | "after" } | null;
  /** How many requests reached it so far. */
  readonly requests: () => number;
  readonly close: () => Promise<void>;
}

export const startFakeGitHubGit = (projectRoot: string, token: string): Promise<FakeGitHubGit> =>
  new Promise((resolve, reject) => {
    let requests = 0;
    const fake: { -readonly [K in keyof FakeGitHubGit]: FakeGitHubGit[K] } = {
      base: "",
      authorizations: [],
      drop: null,
      requests: () => requests,
      close: async () => {},
    };
    const expected = `Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`;
    const server: Server = createServer((request, response) => {
      requests += 1;
      const authorization = request.headers.authorization;
      if (authorization === undefined || authorization !== expected) {
        if (authorization !== undefined) fake.authorizations.push(authorization);
        response.writeHead(401, { "WWW-Authenticate": 'Basic realm="GitHub"' }).end();
        return;
      }
      fake.authorizations.push(authorization);
      const dropping = fake.drop !== null && requests > fake.drop.after && request.method === "POST";
      if (dropping && fake.drop?.when === "before") {
        // Takes the request in, then drops the connection without answering.
        request.resume();
        request.on("end", () => request.socket.destroy());
        return;
      }
      const url = new URL(request.url ?? "/", "http://localhost");
      const backend = spawn("git", ["http-backend"], {
        env: {
          PATH: process.env.PATH,
          GIT_PROJECT_ROOT: projectRoot,
          GIT_HTTP_EXPORT_ALL: "1",
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "/dev/null",
          REMOTE_USER: "x-access-token",
          REQUEST_METHOD: request.method ?? "GET",
          PATH_INFO: decodeURIComponent(url.pathname),
          QUERY_STRING: url.search.slice(1),
          CONTENT_TYPE: request.headers["content-type"] ?? "",
          HTTP_CONTENT_ENCODING: request.headers["content-encoding"] ?? "",
          GIT_PROTOCOL: String(request.headers["git-protocol"] ?? ""),
        },
      });
      request.pipe(backend.stdin);
      const chunks: Array<Buffer> = [];
      backend.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
      backend.on("close", () => {
        if (dropping) {
          request.socket.destroy();
          return;
        }
        const output = Buffer.concat(chunks);
        const split = output.indexOf("\r\n\r\n");
        const head = output.subarray(0, split).toString("utf8");
        const body = output.subarray(split + 4);
        const headers: Record<string, string> = {};
        let status = 200;
        for (const line of head.split("\r\n")) {
          const colon = line.indexOf(":");
          const name = line.slice(0, colon).trim();
          const value = line.slice(colon + 1).trim();
          if (name.toLowerCase() === "status") status = Number(value.split(" ")[0]);
          else headers[name] = value;
        }
        response.writeHead(status, headers).end(body);
      });
    });
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      fake.base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      fake.close = () => new Promise((done) => server.close(() => done()));
      resolve(fake);
    });
  });
