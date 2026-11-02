import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import type { GitHubHosts } from "./github-sign-in.ts";

/**
 * A fake GitHub for tests (#325), on one local HTTP server: the device flow and token refresh of a
 * GitHub App, the REST API the GitHub Charm calls, and Git over HTTP through `git http-backend`.
 * It answers only what the Charm sends, in the fields the Charm reads, the way GitHub's REST API
 * documentation describes them. It is not a general GitHub.
 *
 * Tokens are its own: the device flow and each refresh hand out a new pair, a used refresh token is
 * retired, and the API and Git take only a live access token. Every request is recorded, so a test
 * can tell exactly what reached GitHub and with which credential.
 */

/** One request as it reached the fake: its body is text for the API, and empty for Git. */
export interface FakeGitHubRequest {
  readonly method: string;
  readonly path: string;
  readonly query: URLSearchParams;
  readonly authorization: string | undefined;
  readonly body: string;
}

/** An answer a test makes the fake give instead of its own, or `drop` to close the connection unanswered. */
export type FakeGitHubAnswer =
  | { readonly status: number; readonly body?: unknown; readonly headers?: Record<string, string> }
  | "drop";

export interface FakeComment {
  readonly id: number;
  readonly author: string;
  readonly body: string;
  readonly createdAt: string;
}

export interface FakePullRequestFields {
  readonly head: string;
  readonly base: string;
  readonly draft: boolean;
  readonly mergedAt: string | null;
}

/** An issue or a pull request, which share their numbers as on GitHub. */
export interface FakeItem {
  readonly number: number;
  title: string;
  body: string;
  state: "open" | "closed";
  labels: Array<string>;
  assignees: Array<string>;
  readonly author: string;
  readonly createdAt: string;
  updatedAt: string;
  readonly pullRequest: FakePullRequestFields | null;
  readonly comments: Array<FakeComment>;
}

export interface FakeRepositoryOptions {
  readonly owner: string;
  readonly name: string;
  readonly defaultBranch?: string;
  readonly private?: boolean;
  readonly description?: string | null;
  /** A local repository whose branches it starts with; empty otherwise. */
  readonly from?: string;
}

export interface FakeItemOptions {
  readonly title: string;
  readonly body?: string;
  readonly state?: "open" | "closed";
  readonly labels?: ReadonlyArray<string>;
  readonly assignees?: ReadonlyArray<string>;
  readonly author?: string;
  readonly pullRequest?: { readonly head: string; readonly base: string; readonly merged?: boolean };
}

export interface FakeGitHubOptions {
  /** Where its repositories live, as `<owner>/<name>.git`. */
  readonly folder: string;
  /** The account every token signs in as. */
  readonly login?: string;
  /** Tokens it takes from the start, as a fine-grained token in `HOBBOTS_GITHUB_TOKEN` would be. */
  readonly tokens?: ReadonlyArray<string>;
  /** How many device-flow polls answer `authorization_pending` before the code counts as entered. */
  readonly pendingPolls?: number;
}

export interface FakeGitHub {
  /** Where GitHub's web, API and Git are all served. */
  readonly base: string;
  /** The hosts to give `GitHubSignInLive` and `GitHubApiLive`. */
  readonly hosts: GitHubHosts;
  readonly login: string;
  /** Every request so far, oldest first. */
  readonly requests: ReadonlyArray<FakeGitHubRequest>;
  /** Answers a request in its place when it returns an answer; null to answer every request itself. */
  answer: ((request: FakeGitHubRequest) => FakeGitHubAnswer | undefined) | null;
  /**
   * Drops the connection of every Git push after this many requests, to stand in for a lost answer:
   * `before` GitHub takes it in, or `after` it has applied the push.
   */
  drop: { readonly after: number; readonly when: "before" | "after" } | null;
  readonly createRepository: (options: FakeRepositoryOptions) => string;
  readonly install: (slug: string) => void;
  readonly uninstall: (slug: string) => void;
  readonly addItem: (slug: string, options: FakeItemOptions) => number;
  readonly items: (slug: string) => ReadonlyArray<FakeItem>;
  /** The commit a branch points to, or null when it has none. */
  readonly headOf: (slug: string, branch: string) => string | null;
  /** Every access and refresh token it handed out or took from the start, to look for where they leaked. */
  readonly secrets: () => ReadonlyArray<string>;
  /** Stops taking every access token handed out so far, as when they expire; refresh tokens still work. */
  readonly expireAccessTokens: () => void;
  readonly close: () => Promise<void>;
}

interface Repository {
  readonly owner: string;
  readonly name: string;
  readonly defaultBranch: string;
  readonly private: boolean;
  readonly description: string | null;
  readonly path: string;
  readonly items: Array<FakeItem>;
}

const GIT_PATH = /^\/([^/]+)\/([^/]+)\.git(\/.*)$/;
const PAGE = 30;

const json = (status: number, body: unknown) => ({ status, body }) as const;
const notFound = json(404, { message: "Not Found" });
const invalid = (message: string) => json(422, { message: "Validation Failed", errors: [{ message }] });

const newToken = (prefix: string) => `${prefix}_${randomBytes(18).toString("base64url")}`;

/** The words of a search query: `name:value` qualifiers, a quoted value kept whole, and plain words. */
const qualifiers = (query: string) => {
  const found: Array<[string, string]> = [];
  for (const match of query.matchAll(/(\w+):("[^"]*"|\S+)/g)) {
    found.push([match[1] ?? "", (match[2] ?? "").replace(/^"|"$/g, "")]);
  }
  return found;
};

const matches = (item: FakeItem, [name, value]: [string, string]) => {
  switch (name) {
    case "is":
      if (value === "issue") return item.pullRequest === null;
      if (value === "pr") return item.pullRequest !== null;
      if (value === "merged") return item.pullRequest?.mergedAt != null;
      return item.state === value;
    case "label":
      return item.labels.includes(value);
    case "assignee":
      return item.assignees.includes(value);
    default:
      return true;
  }
};

export const startFakeGitHub = (options: FakeGitHubOptions): Promise<FakeGitHub> => {
  const login = options.login ?? "octocat";
  const repositories = new Map<string, Repository>();
  const installed = new Set<string>();
  const access = new Set<string>(options.tokens ?? []);
  const refresh = new Set<string>();
  const issued: Array<string> = [...(options.tokens ?? [])];
  const requests: Array<FakeGitHubRequest> = [];
  let polls = 0;

  const git = (cwd: string, ...args: Array<string>) =>
    execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
    }).trim();

  const headOf = (slug: string, branch: string) => {
    const repository = repositories.get(slug);
    if (repository === undefined) return null;
    try {
      return git(repository.path, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}^{commit}`);
    } catch {
      return null;
    }
  };

  const pair = () => {
    const accessToken = newToken("ghu");
    const refreshToken = newToken("ghr");
    access.add(accessToken);
    refresh.add(refreshToken);
    issued.push(accessToken, refreshToken);
    return {
      access_token: accessToken,
      expires_in: 28_800,
      refresh_token: refreshToken,
      refresh_token_expires_in: 15_897_600,
      token_type: "bearer",
      scope: "",
    };
  };

  const now = () => new Date().toISOString();

  const itemJson = (repository: Repository, item: FakeItem) => ({
    number: item.number,
    title: item.title,
    state: item.state,
    user: { login: item.author },
    created_at: item.createdAt,
    updated_at: item.updatedAt,
    html_url: `https://github.com/${repository.owner}/${repository.name}/${item.pullRequest ? "pull" : "issues"}/${item.number}`,
    body: item.body,
    labels: item.labels.map((name) => ({ name })),
    comments: item.comments.length,
    ...(item.pullRequest ? { pull_request: { merged_at: item.pullRequest.mergedAt } } : {}),
  });

  const pullJson = (repository: Repository, item: FakeItem) => ({
    number: item.number,
    html_url: `https://github.com/${repository.owner}/${repository.name}/pull/${item.number}`,
    user: { login: item.author },
    created_at: item.createdAt,
    state: item.state,
    title: item.title,
    body: item.body,
    draft: item.pullRequest?.draft ?? false,
    head: { ref: item.pullRequest?.head, label: `${repository.owner}:${item.pullRequest?.head}` },
    base: { ref: item.pullRequest?.base },
  });

  const commentJson = (repository: Repository, item: FakeItem, comment: FakeComment) => ({
    id: comment.id,
    html_url: `https://github.com/${repository.owner}/${repository.name}/issues/${item.number}#issuecomment-${comment.id}`,
    user: { login: comment.author },
    created_at: comment.createdAt,
    body: comment.body,
  });

  const addItem = (repository: Repository, item: FakeItemOptions) => {
    const at = now();
    const added: FakeItem = {
      number: repository.items.length + 1,
      title: item.title,
      body: item.body ?? "",
      state: item.state ?? "open",
      labels: [...(item.labels ?? [])],
      assignees: [...(item.assignees ?? [])],
      author: item.author ?? login,
      createdAt: at,
      updatedAt: at,
      pullRequest:
        item.pullRequest === undefined
          ? null
          : {
              head: item.pullRequest.head,
              base: item.pullRequest.base,
              draft: false,
              mergedAt: item.pullRequest.merged ? at : null,
            },
      comments: [],
    };
    repository.items.push(added);
    return added;
  };

  const signedIn = (request: FakeGitHubRequest) => {
    const [kind, token] = (request.authorization ?? "").split(" ");
    return (kind === "Bearer" || kind === "token") && token !== undefined && access.has(token);
  };

  const parseBody = (request: FakeGitHubRequest): Record<string, unknown> => {
    try {
      const parsed: unknown = JSON.parse(request.body);
      return parsed !== null && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
    } catch {
      return Object.fromEntries(new URLSearchParams(request.body));
    }
  };

  /** The device flow and token refresh of a GitHub App with expiring user tokens. */
  const signIn = (request: FakeGitHubRequest) => {
    const body = parseBody(request);
    if (request.path === "/login/device/code") {
      polls = 0;
      return json(200, {
        device_code: newToken("device"),
        user_code: "FAKE-0001",
        verification_uri: "https://github.com/login/device",
        expires_in: 900,
        interval: 1,
      });
    }
    if (body.grant_type === "refresh_token") {
      const used = String(body.refresh_token ?? "");
      // GitHub retires a refresh token once it is used.
      if (!refresh.delete(used)) return json(200, { error: "bad_refresh_token" });
      return json(200, pair());
    }
    polls += 1;
    if (polls <= (options.pendingPolls ?? 0)) return json(200, { error: "authorization_pending" });
    return json(200, pair());
  };

  const repositoryApi = (request: FakeGitHubRequest, repository: Repository, rest: string) => {
    const slug = `${repository.owner}/${repository.name}`;
    if (rest === "" && request.method === "GET") {
      return json(200, {
        full_name: slug,
        description: repository.description,
        default_branch: repository.defaultBranch,
        visibility: repository.private ? "private" : "public",
        private: repository.private,
        html_url: `https://github.com/${slug}`,
        open_issues_count: repository.items.filter((item) => item.state === "open").length,
      });
    }
    const ref = /^\/git\/ref\/heads\/(.+)$/.exec(rest);
    if (ref !== null && request.method === "GET") {
      const branch = decodeURIComponent(ref[1] ?? "");
      const sha = headOf(slug, branch);
      return sha === null ? notFound : json(200, { ref: `refs/heads/${branch}`, object: { sha, type: "commit" } });
    }
    if (rest === "/pulls") return pulls(request, repository);
    const issue = /^\/issues\/(\d+)(\/comments)?$/.exec(rest);
    const item = repository.items.find((each) => each.number === Number(issue?.[1]));
    if (issue === null || item === undefined) return notFound;
    if (issue[2] === undefined) return request.method === "GET" ? json(200, itemJson(repository, item)) : notFound;
    return comments(request, repository, item);
  };

  const pulls = (request: FakeGitHubRequest, repository: Repository) => {
    const slug = `${repository.owner}/${repository.name}`;
    if (request.method === "POST") {
      const body = parseBody(request);
      const head = String(body.head ?? "");
      const base = String(body.base ?? "");
      if (headOf(slug, head) === null) return invalid(`head: ${head} is not a branch of ${slug}`);
      if (headOf(slug, base) === null) return invalid(`base: ${base} is not a branch of ${slug}`);
      const open = repository.items.find(
        (item) => item.state === "open" && item.pullRequest?.head === head && item.pullRequest.base === base,
      );
      if (open !== undefined) return invalid(`A pull request already exists for ${repository.owner}:${head}.`);
      const added = addItem(repository, {
        title: String(body.title ?? ""),
        body: String(body.body ?? ""),
        pullRequest: { head, base },
      });
      Object.assign(added.pullRequest ?? {}, { draft: body.draft === true });
      return json(201, pullJson(repository, added));
    }
    const head = request.query.get("head");
    const base = request.query.get("base");
    const state = request.query.get("state") ?? "open";
    const found = repository.items
      .filter((item) => item.pullRequest !== null)
      .filter((item) => head === null || `${repository.owner}:${item.pullRequest?.head}` === head)
      .filter((item) => base === null || item.pullRequest?.base === base)
      .filter((item) => state === "all" || item.state === state)
      .sort((a, b) => b.number - a.number);
    return json(
      200,
      page(request, found).map((item) => pullJson(repository, item)),
    );
  };

  const comments = (request: FakeGitHubRequest, repository: Repository, item: FakeItem) => {
    if (request.method === "POST") {
      const comment: FakeComment = {
        id: 1000 * item.number + item.comments.length + 1,
        author: login,
        body: String(parseBody(request).body ?? ""),
        createdAt: now(),
      };
      item.comments.push(comment);
      item.updatedAt = comment.createdAt;
      return json(201, commentJson(repository, item, comment));
    }
    const since = request.query.get("since");
    const found = item.comments.filter((comment) => since === null || comment.createdAt >= since);
    return json(
      200,
      page(request, found).map((comment) => commentJson(repository, item, comment)),
    );
  };

  const page = <A>(request: FakeGitHubRequest, list: ReadonlyArray<A>) => {
    const size = Number(request.query.get("per_page") ?? PAGE);
    const number = Number(request.query.get("page") ?? 1);
    return list.slice((number - 1) * size, number * size);
  };

  const search = (request: FakeGitHubRequest) => {
    const words = qualifiers(request.query.get("q") ?? "");
    const slug = words.find(([name]) => name === "repo")?.[1];
    const repository = slug === undefined ? undefined : repositories.get(slug);
    if (repository === undefined) return invalid("The listed users and repositories cannot be searched.");
    const found = repository.items
      .filter((item) => words.every((word) => matches(item, word)))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.number - a.number);
    return json(200, {
      total_count: found.length,
      incomplete_results: false,
      items: page(request, found).map((item) => itemJson(repository, item)),
    });
  };

  /** The REST API, for a live access token only. */
  const api = (request: FakeGitHubRequest) => {
    if (!signedIn(request)) return json(401, { message: "Bad credentials" });
    if (request.path === "/user") return json(200, { login, id: 1, type: "User" });
    if (request.path === "/user/installations") {
      const installations = installed.size === 0 ? [] : [{ id: 1, account: { login } }];
      return json(200, { total_count: installations.length, installations: page(request, installations) });
    }
    if (request.path === "/user/installations/1/repositories") {
      const list = [...installed].map((slug) => ({
        full_name: slug,
        private: repositories.get(slug)?.private ?? true,
      }));
      return json(200, { total_count: list.length, repositories: page(request, list) });
    }
    if (request.path === "/search/issues") return search(request);
    const repo = /^\/repos\/([^/]+)\/([^/]+)(.*)$/.exec(request.path);
    const repository = repo === null ? undefined : repositories.get(`${repo[1]}/${repo[2]}`);
    if (repo === null || repository === undefined) return notFound;
    return repositoryApi(request, repository, repo[3] ?? "");
  };

  /** Git over HTTP: Basic auth with a live access token as the password, as GitHub takes one. */
  const serveGit = (request: IncomingMessage, response: ServerResponse, body: Buffer, record: FakeGitHubRequest) => {
    const [kind, encoded] = (record.authorization ?? "").split(" ");
    const password =
      kind === "Basic"
        ? Buffer.from(encoded ?? "", "base64")
            .toString("utf8")
            .split(":")
            .slice(1)
            .join(":")
        : "";
    if (!access.has(password)) {
      response.writeHead(401, { "WWW-Authenticate": 'Basic realm="GitHub"' }).end();
      return;
    }
    const dropping = fake.drop !== null && requests.length > fake.drop.after && record.method === "POST";
    if (dropping && fake.drop?.when === "before") {
      request.socket.destroy();
      return;
    }
    const backend = spawn("git", ["http-backend"], {
      env: {
        PATH: process.env.PATH,
        GIT_PROJECT_ROOT: options.folder,
        GIT_HTTP_EXPORT_ALL: "1",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        REMOTE_USER: "x-access-token",
        REQUEST_METHOD: record.method,
        PATH_INFO: record.path,
        QUERY_STRING: record.query.toString(),
        CONTENT_TYPE: request.headers["content-type"] ?? "",
        HTTP_CONTENT_ENCODING: request.headers["content-encoding"] ?? "",
        GIT_PROTOCOL: String(request.headers["git-protocol"] ?? ""),
      },
    });
    backend.stdin.end(body);
    const chunks: Array<Buffer> = [];
    backend.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    backend.on("close", () => {
      if (dropping) {
        request.socket.destroy();
        return;
      }
      const output = Buffer.concat(chunks);
      const split = output.indexOf("\r\n\r\n");
      const headers: Record<string, string> = {};
      let status = 200;
      for (const line of output.subarray(0, split).toString("utf8").split("\r\n")) {
        const colon = line.indexOf(":");
        const name = line.slice(0, colon).trim();
        const value = line.slice(colon + 1).trim();
        if (name.toLowerCase() === "status") status = Number(value.split(" ")[0]);
        else headers[name] = value;
      }
      response.writeHead(status, headers).end(output.subarray(split + 4));
    });
  };

  const handle = (request: IncomingMessage, response: ServerResponse, body: Buffer) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    const path = decodeURIComponent(url.pathname);
    const isGit = GIT_PATH.test(path);
    const record: FakeGitHubRequest = {
      method: request.method ?? "GET",
      path,
      query: url.searchParams,
      authorization: request.headers.authorization,
      body: isGit ? "" : body.toString("utf8"),
    };
    requests.push(record);
    const instead = fake.answer?.(record);
    if (instead === "drop") {
      request.socket.destroy();
      return;
    }
    if (instead === undefined && isGit) {
      serveGit(request, response, body, record);
      return;
    }
    const answer = instead ?? (path.startsWith("/login/") ? signIn(record) : api(record));
    response
      .writeHead(answer.status, {
        "Content-Type": "application/json; charset=utf-8",
        ...("headers" in answer ? answer.headers : {}),
      })
      .end(answer.body === undefined ? "" : JSON.stringify(answer.body));
  };

  const server = createServer((request, response) => {
    const chunks: Array<Buffer> = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => handle(request, response, Buffer.concat(chunks)));
  });

  const fake: FakeGitHub = {
    base: "",
    hosts: { web: "", api: "" },
    login,
    requests,
    answer: null,
    drop: null,
    createRepository: (repository) => {
      const slug = `${repository.owner}/${repository.name}`;
      const path = join(options.folder, repository.owner, `${repository.name}.git`);
      const defaultBranch = repository.defaultBranch ?? "main";
      mkdirSync(join(options.folder, repository.owner), { recursive: true });
      if (repository.from === undefined)
        git(options.folder, "init", "--quiet", "--bare", `--initial-branch=${defaultBranch}`, path);
      else git(options.folder, "clone", "--quiet", "--bare", repository.from, path);
      git(path, "config", "http.receivepack", "true");
      repositories.set(slug, {
        owner: repository.owner,
        name: repository.name,
        defaultBranch,
        private: repository.private ?? true,
        description: repository.description ?? null,
        path,
        items: [],
      });
      return path;
    },
    install: (slug) => void installed.add(slug),
    uninstall: (slug) => void installed.delete(slug),
    addItem: (slug, item) => {
      const repository = repositories.get(slug);
      if (repository === undefined) throw new Error(`The fake GitHub has no repository ${slug}`);
      return addItem(repository, item).number;
    },
    items: (slug) => repositories.get(slug)?.items ?? [],
    headOf,
    secrets: () => [...issued],
    expireAccessTokens: () => access.clear(),
    close: async () => {},
  };

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      Object.assign(fake, {
        base,
        hosts: { web: base, api: base },
        close: () =>
          new Promise<void>((done) => {
            server.closeAllConnections();
            server.close(() => done());
          }),
      });
      resolve(fake);
    });
  });
};
