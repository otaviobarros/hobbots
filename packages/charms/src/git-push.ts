import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { FolderSandbox } from "@hobbots/agents";
import { type GitHubRepository, repositorySlug } from "@hobbots/domain";
import { Context, Data, type Duration, Effect, Layer, Redacted, type Scope, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

/**
 * Pushing without running workspace code (ADR 020). The hub keeps a bare staging repository per
 * folder in its own data folder. It fetches the hob's branch into it with `git-upload-pack` running
 * in the hob's sandbox, fixes the commit the branch points to, and later pushes that commit from the
 * staging repository to a URL it builds itself. Git runs with no system or global configuration, a
 * home of the hub's, an empty hooks folder and prompts off, and the token reaches it only through a
 * credential helper reading a pipe.
 */

/** Why the hub cannot read the branch, or cannot push it, in words for the hob and the person. */
export class PushRefused extends Data.TaggedError("PushRefused")<{ readonly message: string }> {}

/** How a push ended, as the hub can tell from Git. */
export type PushResult =
  /** GitHub took it: the branch is at the commit. */
  | { readonly _tag: "Pushed"; readonly created: boolean; readonly forced: boolean }
  /** GitHub answered no; nothing changed. */
  | { readonly _tag: "Rejected"; readonly message: string }
  /** Nothing reached GitHub, such as a failed DNS lookup or a refused connection. */
  | { readonly _tag: "NotSent"; readonly message: string }
  /** GitHub refused the sign-in, so nothing was done. */
  | { readonly _tag: "SignedOut" }
  /** It may have taken effect: a timeout after sending, a dropped connection or a server error. */
  | { readonly _tag: "Uncertain"; readonly message: string };

/** A branch fetched into the staging repository, at the commit it pointed to then. */
export interface StagedBranch {
  readonly staging: string;
  readonly commit: string;
}

/** What a push sends and where: the commit, to this branch, replacing what the hub read when deciding. */
export interface PushTarget {
  readonly repository: GitHubRepository;
  readonly commit: string;
  readonly remoteBranch: string;
  readonly force: boolean;
  /** The commit the remote branch was at when the hub decided, or null when it did not exist. */
  readonly replaces: string | null;
}

/** How the hub reaches GitHub for a push: HTTPS with the token, or SSH with the user's agent. */
export type PushTransport =
  | { readonly _tag: "Https"; readonly token: Redacted.Redacted<string> }
  | { readonly _tag: "Ssh"; readonly agentSocket: string | undefined };

export interface CommitSummary {
  /** How many commits the push adds that GitHub's branches, as the hub knows them, do not have. */
  readonly count: number;
  /** The first subjects among them, newest first. */
  readonly subjects: ReadonlyArray<string>;
}

export class GitPush extends Context.Service<
  GitPush,
  {
    /**
     * Fetches the hob's branch into the folder's staging repository and fixes its commit. The
     * staging ref is removed when the scope closes.
     */
    readonly stage: (
      folders: ReadonlyArray<string>,
      folder: string,
      branch: string,
    ) => Effect.Effect<StagedBranch, PushRefused, Scope.Scope>;
    /** The commits a push of `commit` adds beyond `known`, the remote commits the staging repository has. */
    readonly commits: (staged: StagedBranch, known: ReadonlyArray<string | null>) => Effect.Effect<CommitSummary>;
    readonly push: (staged: StagedBranch, target: PushTarget, transport: PushTransport) => Effect.Effect<PushResult>;
    /** Whether Git takes the name as a branch name (`git check-ref-format --branch`). */
    readonly isBranchName: (name: string) => Effect.Effect<boolean>;
  }
>()("@hobbots/charms/GitPush") {}

/** Where the hub does its Git work, and where it pushes to. */
export interface GitPushConfig {
  /** The hub's own folder for this work, inside its data folder: staging repositories, a home, empty hooks. */
  readonly folder: string;
  /** Where repositories are pushed over HTTPS: `https://github.com`, or a fake GitHub in tests. */
  readonly httpsBase?: string;
  /** The hub's own environment, for PATH and its proxy settings. */
  readonly env?: NodeJS.ProcessEnv;
  readonly pushTimeout?: Duration.Input;
}

/**
 * GitHub's published SSH host keys for github.com, so an SSH push trusts no key a hob or a network
 * could put in its way. Their SHA256 fingerprints: ed25519 +DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU,
 * ECDSA p2QAMXNIC1TJYWeIOttrVc98/R1BUFWu3/LiyKgUfQM, RSA uNiVztksCsDhcc0u9e8BujQXVUpKZIDTMczCvj3tD2s.
 */
export const GITHUB_KNOWN_HOSTS = [
  "github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl",
  "github.com ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBEmKSENjQEezOmxkZMy7opKgwFB9nkt5YRrYMjNuG5N87uRgg6CLrbo5wAdT/y6v0mKV0U2w0WZ2YB/++Tpockg=",
  "github.com ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABgQCj7ndNxQowgcQnjshcLrqPEiiphnt+VTTvDP6mHBL9j1aNUkY4Ue1gvwnGLVlOhGeYrnZaMgRK6+PKCUXaDbC7qtbW8gIkhL7aGCsOr/C56SJMy/BCZfxd1nWzAOxSDPgVsmerOBYfNqltV9/hWCqBywINIR+5dIg6JTJ72pcEpEjcYgXkE2YEFXV1JHnsKgbLWNlhScqb2UmyRkQyytRLtL+38TGxkxCflmO+5Z8CSSNY7GidjMIZ7Q4zMjA2n1nGrlTDkzwDCsw+wqFPGQA179cnfGWOWRVruj16z6XyvxvjJwbz0wQZ75XK5tKSb7FNyeIEs4TT4jk+S4dhPeAUC5y+bDYirYgM4GC7uEnztnZyaVWQ7B381AK4Qdrwt51ZqExKbQpTUNn+EjqoTwvqNj4kqx5QUCI0ThS/YkOxJCXmPUWZbhjpCg56i+2aB6CmK2JGhn57K5mj0MNdBXA4/WnwH6XoPWJzK5Nyu2zB3nAZp+S5hpQs+p1vN1/wsjk=",
];

/** Files a hob can write that make Git read another repository's objects or history; a folder with one is refused. */
const REFUSED_LAYOUT: ReadonlyArray<readonly [string, string]> = [
  ["commondir", "points its repository at another one"],
  [join("objects", "info", "alternates"), "borrows objects from another repository"],
  [join("info", "grafts"), "rewrites its history with grafts"],
  ["shallow", "is a shallow clone"],
];

/** What a hex commit id looks like, so nothing else is passed where Git expects one. */
const isCommitId = (text: string) => /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(text);

const exists = (path: string) =>
  Effect.promise(() =>
    lstat(path).then(
      () => true,
      () => false,
    ),
  );

/** The variables a Git process of the hub's runs with: nothing a hob or the user's Git setup chose. */
export const hubGitEnv = (env: NodeJS.ProcessEnv, home: string): Record<string, string> => {
  const passed: Record<string, string> = {
    HOME: home,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_NO_REPLACE_OBJECTS: "1",
    // Git's messages are read by the hub, so they stay in English.
    LC_ALL: "C",
    LANG: "C",
  };
  // The hub's own network settings, so a push reaches GitHub the way the hub does.
  for (const key of ["PATH", "HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "NO_PROXY", "no_proxy"]) {
    const value = env[key];
    if (value !== undefined && value !== "") passed[key] = value;
  }
  return passed;
};

/** The credential helper: it answers `get` with what the hub writes to its file descriptor 3, and nothing else. */
export const PIPE_HELPER = '!f() { test "$1" = get && cat <&3; }; f';

/** What Git is told for a GitHub token: GitHub takes any user name with a token as the password. */
const credential = (token: Redacted.Redacted<string>) =>
  new TextEncoder().encode(`username=x-access-token\npassword=${Redacted.value(token)}\n\n`);

/** Reads `git push --porcelain`'s line for the ref: its flag and summary. */
export const porcelainLine = (
  stdout: string,
  ref: string,
): { readonly flag: string; readonly summary: string } | null => {
  for (const line of stdout.split("\n")) {
    const parts = line.split("\t");
    if (parts.length < 3) continue;
    const [flag, refs, summary] = parts as [string, string, string];
    if (refs.endsWith(`:${ref}`)) return { flag, summary };
  }
  return null;
};

const NOT_SENT = [
  "Could not resolve host",
  "Could not resolve hostname",
  "Failed to connect",
  "Connection refused",
  "Couldn't connect to server",
  "Network is unreachable",
  "No route to host",
  "Host key verification failed",
];

/** What GitHub said about the ref in Git's porcelain output, when it said anything. */
const fromPorcelain = (exit: number, stdout: string, ref: string): PushResult | null => {
  const line = porcelainLine(stdout, ref);
  if (line === null) return null;
  if (line.flag === "!") {
    const moved = ["fetch first", "non-fast-forward", "stale info"].some((words) => line.summary.includes(words));
    const notes = [
      moved
        ? "The branch on GitHub moved since you last had it, and you cannot fetch it yet: ask the user to bring your branch up to date."
        : "",
      line.summary.includes("workflow") ? "Hobbots cannot push changes to GitHub Actions workflows." : "",
    ].filter((note) => note !== "");
    return { _tag: "Rejected", message: [`GitHub refused the push: ${line.summary}.`, ...notes].join(" ") };
  }
  if (exit === 0 || ["=", " ", "+", "*"].includes(line.flag)) {
    return { _tag: "Pushed", created: line.flag === "*", forced: line.flag === "+" };
  }
  return null;
};

/** What Git's messages say when the porcelain output said nothing about the ref. */
const fromMessages = (stderr: string): PushResult => {
  const said = stderr.trim();
  const has = (...words: ReadonlyArray<string>) => words.some((word) => said.includes(word));
  if (has("Authentication failed", "returned error: 401")) return { _tag: "SignedOut" };
  if (has("returned error: 403", "Permission to", "Permission denied")) {
    return {
      _tag: "Rejected",
      message: "GitHub refused the push: the sign-in the hub uses may not push to this repository.",
    };
  }
  if (has("Repository not found", "returned error: 404")) {
    return { _tag: "Rejected", message: "GitHub has no such repository, or the sign-in the hub uses cannot see it." };
  }
  if (has(...NOT_SENT)) return { _tag: "NotSent", message: "The hub could not reach GitHub, so nothing was sent." };
  return {
    _tag: "Uncertain",
    message: "The push ended without a clear answer from GitHub, so it may or may not have taken effect.",
  };
};

/**
 * How a push ended, from Git's exit, its porcelain output and its messages. Anything Git did not say
 * clearly is uncertain, never assumed not sent.
 */
export const pushResult = (exit: number, stdout: string, stderr: string, ref: string): PushResult =>
  fromPorcelain(exit, stdout, ref) ?? fromMessages(stderr);

const folderKey = (folder: string) => createHash("sha256").update(folder).digest("hex").slice(0, 24);

export const GitPushLive = (config: GitPushConfig) =>
  Layer.effect(
    GitPush,
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const sandbox = yield* FolderSandbox;
      const env = config.env ?? process.env;
      const home = join(config.folder, "home");
      const hooks = join(config.folder, "hooks");
      const knownHosts = join(config.folder, "known_hosts");
      const httpsBase = config.httpsBase ?? "https://github.com";
      const prepared = Effect.promise(async () => {
        for (const dir of [config.folder, home, hooks, join(config.folder, "staging")]) {
          await mkdir(dir, { recursive: true, mode: 0o700 });
        }
        await writeFile(knownHosts, `${GITHUB_KNOWN_HOSTS.join("\n")}\n`, { mode: 0o600 });
      }).pipe(Effect.cached);
      const ready = yield* prepared;

      // Settings every Git command of the hub's starts with: no hooks, no fsmonitor, and only the
      // transports the hub itself names.
      const base = [
        "-c",
        `core.hooksPath=${hooks}`,
        "-c",
        "core.fsmonitor=false",
        "-c",
        "protocol.allow=never",
        "-c",
        "protocol.file.allow=always",
        "-c",
        `protocol.${new URL(httpsBase).protocol.replace(":", "")}.allow=always`,
        "-c",
        "protocol.ssh.allow=always",
      ];

      const run = (
        args: ReadonlyArray<string>,
        options: {
          readonly extraEnv?: Record<string, string>;
          readonly input?: Uint8Array;
          readonly timeout?: Duration.Input;
        } = {},
      ) =>
        Effect.scoped(
          Effect.gen(function* () {
            yield* ready;
            const handle = yield* spawner.spawn(
              ChildProcess.make("git", [...base, ...args], {
                env: { ...hubGitEnv(env, home), ...options.extraEnv },
                extendEnv: false,
                stdin: "ignore",
                ...(options.input === undefined
                  ? {}
                  : { additionalFds: { fd3: { type: "input" as const, stream: Stream.make(options.input) } } }),
              }),
            );
            const [stdout, stderr, exit] = yield* Effect.all(
              [
                Stream.mkString(Stream.decodeText(handle.stdout)),
                Stream.mkString(Stream.decodeText(handle.stderr)),
                handle.exitCode,
              ],
              { concurrency: "unbounded" },
            );
            return { stdout, stderr, exit: Number(exit) };
          }),
        ).pipe(Effect.timeout(options.timeout ?? "30 seconds"));

      const git = (args: ReadonlyArray<string>) =>
        run(args).pipe(
          Effect.flatMap((out) =>
            out.exit === 0 ? Effect.succeed(out.stdout.trim()) : Effect.fail(new PushRefused({ message: out.stderr })),
          ),
          Effect.mapError((error) =>
            error._tag === "PushRefused" ? error : new PushRefused({ message: "Git did not answer in time." }),
          ),
          Effect.catchDefect(() => Effect.fail(new PushRefused({ message: "Git could not run on the hub." }))),
        );

      const stagingOf = (folder: string) =>
        Effect.gen(function* () {
          const staging = join(config.folder, "staging", `${folderKey(folder)}.git`);
          if (!(yield* exists(join(staging, "HEAD")))) yield* git(["init", "--bare", "--quiet", staging]);
          return staging;
        });

      const stage = (folders: ReadonlyArray<string>, folder: string, branch: string) =>
        Effect.gen(function* () {
          const gitDir = join(folder, ".git");
          for (const [file, what] of REFUSED_LAYOUT) {
            if (yield* exists(join(gitDir, file))) {
              return yield* new PushRefused({
                message: `${folder} ${what} (${join(".git", file)}), so Hobbots will not push from it.`,
              });
            }
          }
          const staging = yield* stagingOf(folder);
          // The source side runs in the hob's sandbox: whatever its repository's files point at, it
          // reads nothing outside the hob's folders, writes nothing and reaches no network.
          const uploadPack = yield* sandbox
            .readOnly(folders, "env", [
              "GIT_CONFIG_NOSYSTEM=1",
              "GIT_CONFIG_GLOBAL=/dev/null",
              "GIT_NO_REPLACE_OBJECTS=1",
              "GIT_TERMINAL_PROMPT=0",
              "git",
              "upload-pack",
              // Strict: the repository at the top of the folder, never one Git would look for elsewhere.
              "--strict",
              "--",
              gitDir,
            ])
            .pipe(Effect.mapError((error) => new PushRefused({ message: error.message })));
          const ref = `refs/hobbots/push/${randomUUID()}`;
          yield* Effect.acquireRelease(
            run(
              [
                "-C",
                staging,
                "fetch",
                "--quiet",
                "--no-tags",
                "--no-write-fetch-head",
                "--no-recurse-submodules",
                `--upload-pack=${uploadPack.commandLine}`,
                "--end-of-options",
                folder,
                `refs/heads/${branch}:${ref}`,
              ],
              { extraEnv: { ...uploadPack.env }, timeout: "2 minutes" },
            ).pipe(
              Effect.mapError(() => new PushRefused({ message: "Reading your branch took too long." })),
              Effect.flatMap((out) =>
                out.exit === 0
                  ? Effect.void
                  : Effect.fail(
                      new PushRefused({
                        message: `Hobbots could not read the branch ${branch} from ${folder}. Check that it exists and has commits.`,
                      }),
                    ),
              ),
            ),
            () => git(["-C", staging, "update-ref", "-d", "--end-of-options", ref]).pipe(Effect.ignore),
          );
          const commit = yield* git(["-C", staging, "rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`]);
          if (!isCommitId(commit)) return yield* new PushRefused({ message: "Git named no commit for the branch." });
          return { staging, commit };
        });

      const commits = (staged: StagedBranch, known: ReadonlyArray<string | null>) =>
        Effect.gen(function* () {
          const present: Array<string> = [];
          for (const commit of known) {
            if (commit === null || !isCommitId(commit) || present.includes(commit)) continue;
            const found = yield* run([
              "-C",
              staged.staging,
              "cat-file",
              "-e",
              "--end-of-options",
              `${commit}^{commit}`,
            ]);
            if (found.exit === 0) present.push(commit);
          }
          // Every word is a commit id checked above, so none reads as an option; `--not` must stay one.
          const range = [staged.commit, "--not", ...present];
          const count = Number(yield* git(["-C", staged.staging, "rev-list", "--count", ...range]));
          const log = yield* git(["-C", staged.staging, "log", "--format=%s", "--max-count=5", ...range]);
          return { count, subjects: log === "" ? [] : log.split("\n") };
        }).pipe(Effect.orElseSucceed(() => ({ count: 0, subjects: [] })));

      const push = (staged: StagedBranch, target: PushTarget, transport: PushTransport) =>
        Effect.gen(function* () {
          const ref = `refs/heads/${target.remoteBranch}`;
          const slug = repositorySlug(target.repository);
          const url = transport._tag === "Ssh" ? `git@github.com:${slug}.git` : `${httpsBase}/${slug}.git`;
          // A force push replaces only the commit the hub read when deciding; a push without force never forces.
          const lease = target.force ? [`--force-with-lease=${ref}:${target.replaces ?? ""}`] : [];
          const access =
            transport._tag === "Https"
              ? [
                  "-c",
                  "credential.helper=",
                  "-c",
                  `credential.helper=${PIPE_HELPER}`,
                  "-c",
                  "credential.useHttpPath=false",
                ]
              : [];
          const sshEnv: Record<string, string> =
            transport._tag === "Ssh"
              ? {
                  GIT_SSH_COMMAND: `ssh -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=${knownHosts} -o HostKeyAlias=github.com`,
                  GIT_SSH_VARIANT: "ssh",
                  ...(transport.agentSocket ? { SSH_AUTH_SOCK: transport.agentSocket } : {}),
                }
              : {};
          const out = yield* run(
            [
              ...access,
              "-C",
              staged.staging,
              "push",
              "--porcelain",
              "--no-verify",
              ...lease,
              "--end-of-options",
              url,
              `${staged.commit}:${ref}`,
            ],
            {
              extraEnv: sshEnv,
              timeout: config.pushTimeout ?? "2 minutes",
              ...(transport._tag === "Https" ? { input: credential(transport.token) } : {}),
            },
          ).pipe(Effect.option);
          if (out._tag === "None") {
            return { _tag: "Uncertain", message: "GitHub did not answer the push in time." } as const;
          }
          return pushResult(out.value.exit, out.value.stdout, out.value.stderr, ref);
        }).pipe(
          Effect.catchDefect(() =>
            Effect.succeed<PushResult>({ _tag: "NotSent", message: "Git could not run on the hub." }),
          ),
        );

      const isBranchName = (name: string) =>
        run(["-C", home, "check-ref-format", "--branch", name]).pipe(
          Effect.map((out) => out.exit === 0 && out.stdout.trim() === name),
          Effect.orElseSucceed(() => false),
        );

      return GitPush.of({ stage, commits, push, isBranchName });
    }),
  );
