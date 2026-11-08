import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeServices } from "@effect/platform-node";
import type { AgentId } from "@hobbots/domain";
import { Effect, Layer, Option, Redacted } from "effect";
import { afterAll, describe, expect, it } from "vitest";
import {
  HobAppKeys,
  HobAppKeysLive,
  hubKeychainScope,
  Keychain,
  KeychainLive,
  LegacyKeychain,
  LegacyKeychainLive,
  LocalGitHubSignIns,
  LocalGitHubSignInsLive,
} from "../src/index.ts";

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

const SCOPE = "0123456789abcdef";

const withKeychain = <A>(
  platform: NodeJS.Platform,
  use: (keychain: Keychain["Service"]) => Effect.Effect<A, unknown>,
) =>
  Effect.gen(function* () {
    return yield* use(yield* Keychain);
  }).pipe(
    Effect.provide(KeychainLive(platform, env, SCOPE).pipe(Layer.provide(NodeServices.layer))),
    Effect.runPromise,
  );

// A stand-in for `security` that keeps what it is given in files, one per service and account, as
// the macOS Keychain keeps one item per pair, so two hubs on one computer share it as they would.
const shared = mkdtempSync(join(tmpdir(), "hobbots-shared-keychain-"));
afterAll(() => rmSync(shared, { recursive: true, force: true }));
mkdirSync(join(shared, "items"));
writeFileSync(
  join(shared, "security"),
  `#!/bin/sh
items="${join(shared, "items")}"
if [ "$1" = "-i" ]; then set -- $(cat); fi
command=$1; shift
while [ $# -gt 0 ]; do
  case "$1" in
    -s) service=$2; shift 2;;
    -a) account=$2; shift 2;;
    -w) shift; if [ $# -gt 0 ]; then secret=$1; shift; fi;;
    *) shift;;
  esac
done
item="$items/$service@$account"
case "$command" in
  add-generic-password) printf '%s' "$secret" > "$item";;
  find-generic-password) [ -f "$item" ] || exit 44; cat "$item"; echo;;
  delete-generic-password) [ -f "$item" ] || exit 44; rm "$item";;
esac
`,
);
chmodSync(join(shared, "security"), 0o755);
const sharedEnv = { PATH: `${shared}:/usr/bin:/bin`, HOME: shared };
const items = () => readdirSync(join(shared, "items")).sort();

/** One hub's GitHub sign-in and hobs' app keys on the computer with the shared keychain. */
const hubOn = (dataDir: string) => {
  const scope = hubKeychainScope(dataDir);
  const layer = Layer.mergeAll(
    KeychainLive("darwin", sharedEnv, scope),
    HobAppKeysLive("darwin", sharedEnv, scope),
    LegacyKeychainLive("darwin", sharedEnv),
  ).pipe(Layer.provide(NodeServices.layer));
  return <A>(use: Effect.Effect<A, unknown, Keychain | HobAppKeys | LegacyKeychain>) =>
    use.pipe(Effect.provide(layer), Effect.runPromise);
};

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
      "stdin: add-generic-password -U -s ai.hobbots.hub-0123456789abcdef.github -a github.com -w c2VjcmV0",
      // Read back, since `security -i` can exit 0 when its command failed.
      "security find-generic-password -s ai.hobbots.hub-0123456789abcdef.github -a github.com -w",
      "security find-generic-password -s ai.hobbots.hub-0123456789abcdef.github -a github.com -w",
      "security delete-generic-password -s ai.hobbots.hub-0123456789abcdef.github -a github.com",
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
      "secret-tool store --label=Hobbots GitHub service ai.hobbots.hub-0123456789abcdef.github account github.com",
      "stdin: c2VjcmV0",
      "secret-tool lookup service ai.hobbots.hub-0123456789abcdef.github account github.com",
    ]);

    // A secret that would need quoting on `security`'s input line is never written.
    const quoted = await withKeychain("darwin", (keychain) => Effect.result(keychain.write(Redacted.make("a b"))));
    expect(quoted).toMatchObject({ _tag: "Failure" });
  });

  it("[TC-GEN-033] reads the gh and Git sign-ins on the hub, Git with the request on its input", async () => {
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

describe("Hubs sharing one computer's keychain (#1214)", () => {
  const frodo = "frodo" as AgentId;
  const signIn = Effect.flatMap(Keychain, (keychain) => keychain.read).pipe(Effect.map(Option.map(Redacted.value)));

  // covers ADR 020, ADR 022
  it("[TC-PE-1214-01] keeps each hub's sign-in and app keys apart, so one hub's delete leaves the other's", async () => {
    const hubA = hubOn("/Users/someone/Library/Application Support/Hobbots");
    const hubB = hubOn("/Users/someone/hobbots-qa/hub-b");
    expect(hubKeychainScope("/a")).not.toBe(hubKeychainScope("/b"));
    expect(hubKeychainScope("/a")).toBe(hubKeychainScope("/a"));

    await hubA(
      Effect.gen(function* () {
        yield* (yield* Keychain).write(Redacted.make("aaaa"));
        yield* (yield* HobAppKeys).write(frodo, Redacted.make("-----BEGIN KEY A-----"));
      }),
    );
    // Connect on the second hub writes its own item, not over the first hub's.
    await hubB(Effect.flatMap(Keychain, (keychain) => keychain.write(Redacted.make("bbbb"))));
    expect(await hubA(signIn)).toEqual(Option.some("aaaa"));
    expect(await hubB(signIn)).toEqual(Option.some("bbbb"));

    // What Start over on the second hub deletes: its own sign-in and its hobs' keys.
    await hubB(
      Effect.gen(function* () {
        yield* (yield* Keychain).remove;
        yield* (yield* HobAppKeys).remove(frodo);
      }),
    );
    expect(await hubB(signIn)).toEqual(Option.none());
    expect(await hubA(signIn)).toEqual(Option.some("aaaa"));
    const key = await hubA(Effect.flatMap(HobAppKeys, (keys) => keys.read(frodo)));
    expect(Option.map(key, Redacted.value)).toEqual(Option.some("-----BEGIN KEY A-----"));

    const scopeA = hubKeychainScope("/Users/someone/Library/Application Support/Hobbots");
    expect(items()).toEqual([
      `ai.hobbots.hub-${scopeA}.github.hob-app@frodo`,
      `ai.hobbots.hub-${scopeA}.github@github.com`,
    ]);
  });

  it("reads the items every hub shared before under their old names", async () => {
    writeFileSync(join(shared, "items", "ai.hobbots.github@github.com"), "c2hhcmVk");
    writeFileSync(
      join(shared, "items", "ai.hobbots.github.hob-app@frodo"),
      Buffer.from("-----BEGIN OLD KEY-----").toString("base64url"),
    );
    const hub = hubOn("/Users/someone/elsewhere");
    const found = await hub(
      Effect.gen(function* () {
        const legacy = yield* LegacyKeychain;
        return [yield* legacy.signIn.read, yield* legacy.hobAppKeys.read(frodo)].map(Option.map(Redacted.value));
      }),
    );
    expect(found).toEqual([Option.some("c2hhcmVk"), Option.some("-----BEGIN OLD KEY-----")]);
  });
});
