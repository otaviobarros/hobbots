import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { Effect } from "effect";
import { AI_MEMORY_VERSION, type EngineTarget, engineTarget } from "./release.ts";

const execFileAsync = promisify(execFile);

/** The engine's binary and its checksum file, side by side in the engine folder. */
export const ENGINE_BINARY = "ai-memory";
export const ENGINE_CHECKSUM = "ai-memory.sha256";

/** The engine folder of a checkout for a target, where `fetch-engine` puts it. */
export const checkoutEngineFolder = (target: EngineTarget) => resolve(import.meta.dirname, "../../engine", target);

/**
 * Where a checkout's hub finds its engine: this machine's folder from `fetch-engine`. The desktop
 * app passes the copy in its resources instead.
 */
export const defaultEngineFolder = (): string | undefined => {
  const target = engineTarget(process.platform, process.arch);
  return target === undefined ? undefined : checkoutEngineFolder(target);
};

/** The SHA-256 of a file, as lowercase hex. */
export const sha256File = (path: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    createReadStream(path)
      .on("data", (chunk) => hash.update(chunk))
      .on("error", reject)
      .on("end", () => resolve(hash.digest("hex")));
  });

/** A checksum file's line for the binary, in the format `shasum -a 256` writes and `-c` reads. */
export const checksumLine = (sha256: string) => `${sha256}  ${ENGINE_BINARY}\n`;

/** The hex digest a checksum file names, or undefined when it names none. */
export const parseChecksum = (text: string): string | undefined => /^([0-9a-f]{64})(?:\s|$)/.exec(text.trim())?.[1];

/** The `ai-memory --version` line's version, such as `3.4.2` from `ai-memory 3.4.2`. */
export const parseVersion = (output: string): string | undefined => /^ai-memory (\S+)$/m.exec(output)?.[1];

/**
 * The engine binary to run, or why there is none: `Missing` when the folder holds no binary or no
 * checksum, `Mismatch` when the binary is not the one the checksum names, or not the pinned version.
 */
export type EngineBinary =
  | { readonly _tag: "Verified"; readonly path: string }
  | { readonly _tag: "Missing"; readonly detail: string }
  | { readonly _tag: "Mismatch"; readonly detail: string };

/**
 * Checks the engine in `folder` before it runs (ADR 028): its SHA-256 against the checksum written
 * when it was fetched or packaged, then its version against the pinned release. Nothing is run when
 * the checksum does not match.
 */
export const verifyEngine = (folder: string): Effect.Effect<EngineBinary> =>
  Effect.gen(function* () {
    const path = join(folder, ENGINE_BINARY);
    const expected = yield* Effect.tryPromise(() => readFile(join(folder, ENGINE_CHECKSUM), "utf8")).pipe(
      Effect.option,
    );
    if (expected._tag === "None") return { _tag: "Missing", detail: `No ${ENGINE_CHECKSUM} in ${folder}` } as const;
    const want = parseChecksum(expected.value);
    if (want === undefined) return { _tag: "Mismatch", detail: `${ENGINE_CHECKSUM} names no SHA-256` } as const;
    const actual = yield* Effect.tryPromise(() => sha256File(path)).pipe(Effect.option);
    if (actual._tag === "None") return { _tag: "Missing", detail: `No ${ENGINE_BINARY} in ${folder}` } as const;
    if (actual.value !== want) {
      return { _tag: "Mismatch", detail: `${ENGINE_BINARY} has SHA-256 ${actual.value}, expected ${want}` } as const;
    }
    const output = yield* Effect.tryPromise(() =>
      execFileAsync(path, ["--version"], { timeout: 10_000, env: {} }).then((result) => result.stdout),
    ).pipe(Effect.orElseSucceed(() => ""));
    const version = parseVersion(output);
    if (version !== AI_MEMORY_VERSION) {
      return {
        _tag: "Mismatch",
        detail: `${ENGINE_BINARY} reports version ${version ?? "none"}, expected ${AI_MEMORY_VERSION}`,
      } as const;
    }
    return { _tag: "Verified", path } as const;
  });
