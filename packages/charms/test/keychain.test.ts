import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeServices } from "@effect/platform-node";
import { Effect, Layer, Option, Redacted } from "effect";
import { afterAll, describe, expect, it } from "vitest";
import { Keychain, KeychainLive, LocalGitHubSignIns, LocalGitHubSignInsLive } from "../src/index.ts";

// Stand-ins for `security`, `secret-tool`, `gh` and `git` on PATH: each records its arguments and
// what it read on its standard input, then answers as the real tool would.
const bin = mkdtempSync(join(tmpdir(), "hobbots-keychain-"));
const log = join(bin, "log");
afterAll(() => rmSync(bin, { recursive: true, force: true }));

const tool = (name: string, body: string) => {
  const path = join(bin, name);
  writeFileSync(
    path,
    `#!/bin/sh\nprintf '%s\\n' "${name} $*" >> "${log}"\ninput=$(cat)\n[ -n "$input" ] && printf 'stdin: %s\\n' "$input" >> "${log}"\n${body}\n`,
  );
  chmodSync(path, 0o755);
};
tool("security", 'case "$1" in find-generic-password) echo c2VjcmV0; exit 0;; *) exit 0;; esac');
tool("secret-tool", 'case "$1" in lookup) exit 1;; *) exit 0;; esac');
tool("gh", "echo gho_fromTheCli000000000000000");
tool("git", 'printf "protocol=https\\nhost=github.com\\nusername=x\\npassword=gho_fromGit00000000000000000\\n"');

const env = { PATH: `${bin}:/usr/bin:/bin`, HOME: bin };
const lines = () => readFileSync(log, "utf8").trim().split("\n");

const withKeychain = <A>(
  platform: NodeJS.Platform,
  use: (keychain: Keychain["Service"]) => Effect.Effect<A, unknown>,
) =>
  Effect.gen(function* () {
    return yield* use(yield* Keychain);
  }).pipe(Effect.provide(KeychainLive(platform, env).pipe(Layer.provide(NodeServices.layer))), Effect.runPromise);

describe("The keychain on the hub", () => {
  it("[TC-PE-147] hands the GitHub sign-in to the keychain tool on its input, never on a command line", async () => {
    writeFileSync(log, "");
    const read = await withKeychain("darwin", (keychain) =>
      Effect.gen(function* () {
        yield* keychain.write(Redacted.make("c2VjcmV0"));
        const item = yield* keychain.read;
        yield* keychain.remove;
        return Option.map(item, Redacted.value);
      }),
    );
    expect(read).toEqual(Option.some("c2VjcmV0"));
    expect(lines()).toEqual([
      "security -i",
      "stdin: add-generic-password -U -s ai.hobbots.github -a github.com -w c2VjcmV0",
      // Read back, since `security -i` can exit 0 when its command failed.
      "security find-generic-password -s ai.hobbots.github -a github.com -w",
      "security find-generic-password -s ai.hobbots.github -a github.com -w",
      "security delete-generic-password -s ai.hobbots.github -a github.com",
    ]);

    writeFileSync(log, "");
    const none = await withKeychain("linux", (keychain) =>
      Effect.gen(function* () {
        yield* keychain.write(Redacted.make("c2VjcmV0"));
        return yield* keychain.read;
      }),
    );
    expect(Option.isNone(none)).toBe(true);
    expect(lines()).toEqual([
      "secret-tool store --label=Hobbots GitHub service ai.hobbots.github account github.com",
      "stdin: c2VjcmV0",
      "secret-tool lookup service ai.hobbots.github account github.com",
    ]);

    // A secret that would need quoting on `security`'s input line is never written.
    const quoted = await withKeychain("darwin", (keychain) => Effect.result(keychain.write(Redacted.make("a b"))));
    expect(quoted).toMatchObject({ _tag: "Failure" });
  });

  it("reads the gh and Git sign-ins on the hub, Git with the request on its input", async () => {
    writeFileSync(log, "");
    const tokens = await Effect.gen(function* () {
      const local = yield* LocalGitHubSignIns;
      return [yield* local.token("gh"), yield* local.token("git")].map((token) => Option.map(token, Redacted.value));
    }).pipe(Effect.provide(LocalGitHubSignInsLive(env).pipe(Layer.provide(NodeServices.layer))), Effect.runPromise);
    expect(tokens).toEqual([Option.some("gho_fromTheCli000000000000000"), Option.some("gho_fromGit00000000000000000")]);
    expect(lines()).toEqual([
      "gh auth token --hostname github.com",
      "git -c credential.interactive=never credential fill",
      "stdin: protocol=https",
      "host=github.com",
    ]);
  });
});
