// Runs Biome with the repository's biome.json over probe files in a temporary folder, for the tests that prove
// a lint rule or a GritQL plugin.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const biome = join(root, "node_modules/.bin/biome");

/**
 * Writes each probe file, lints them all and removes the folder again. Returns `fails` and `passes`
 * assertions over the diagnostics, keyed by file path and diagnostic category.
 */
export const lintProbes = (/** @type {Record<string, string>} */ probes) => {
  const dir = mkdtempSync(join(tmpdir(), "hobbots-biome-probes-"));
  try {
    copyFileSync(join(root, "biome.json"), join(dir, "biome.json"));
    // biome.json loads its GritQL plugins from scripts/biome.
    cpSync(join(root, "scripts/biome"), join(dir, "scripts/biome"), { recursive: true });
    for (const [file, source] of Object.entries(probes)) {
      mkdirSync(dirname(join(dir, file)), { recursive: true });
      writeFileSync(join(dir, file), source);
    }
    let output;
    try {
      output = execFileSync(biome, ["lint", "--vcs-enabled=false", "--reporter=json", "--max-diagnostics=none", "."], {
        cwd: dir,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch (error) {
      output = error.stdout;
    }
    const found = new Set(
      JSON.parse(output).diagnostics.map(({ location, category }) => `${location.path} ${category}`),
    );
    return {
      fails: (file, category) => assert.ok(found.has(`${file} ${category}`), `${file} should fail ${category}`),
      passes: (file, category) => assert.ok(!found.has(`${file} ${category}`), `${file} should pass ${category}`),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};
