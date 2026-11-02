import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeviceSecrets, WindowKey } from "@hobbots/agents";
import { Effect, Layer } from "effect";
import { afterAll, describe, expect, it } from "vitest";
import { DeviceSecretsLive, WindowKeyLive } from "../src/devices.ts";
import { windowKeyFile } from "../src/window-key.ts";

const dataDir = mkdtempSync(join(tmpdir(), "hobbots-window-key-"));
afterAll(() => rmSync(dataDir, { recursive: true, force: true }));

/** Starts the window key as the hub does, and returns the key file's text and mode with the kept hash. */
const start = () =>
  Effect.gen(function* () {
    const { hash } = yield* WindowKey;
    const secrets = yield* DeviceSecrets;
    const file = windowKeyFile(dataDir);
    const key = readFileSync(file, "utf8").trim();
    return { key, hash, matches: (yield* secrets.hash(key)) === hash, mode: statSync(file).mode & 0o777 };
  }).pipe(Effect.provide(WindowKeyLive(dataDir).pipe(Layer.provideMerge(DeviceSecretsLive))), Effect.runPromise);

describe("the window key", () => {
  // covers DP-004
  it("[TC-DP-084] writes a fresh key on every start that only the user can read, and keeps only its hash", async () => {
    const first = await start();
    const second = await start();
    expect(first.key).toMatch(/^hbw_[A-Za-z0-9_-]{43}$/);
    expect(first.mode).toBe(0o600);
    expect(first.matches).toBe(true);
    expect(first.hash).not.toContain(first.key);
    // The next start ends the old key.
    expect(second.key).not.toBe(first.key);
    expect(second.hash).not.toBe(first.hash);
  });
});
