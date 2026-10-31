// Runs Biome with the repository's biome.json over probe files, to prove the layer import rules (STD-ARCH-001..004).

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const biome = join(root, "node_modules/.bin/biome");

const probes = {
  "packages/domain/src/allowed.ts": 'import { Schema } from "effect";\nimport { id } from "./id.ts";\n',
  "packages/domain/src/package.ts": 'import pg from "pg";\n',
  "packages/domain/src/scoped.ts": 'import { a } from "@scope/pkg";\n',
  "packages/domain/src/subpath.ts": 'import { Schema } from "effect/Schema";\n',
  "packages/domain/src/node.ts": 'import { readFileSync } from "fs";\n',
  "packages/agents/src/node.ts": 'import { readFileSync } from "fs";\n',
  "packages/api/src/node.ts": 'import { readFileSync } from "fs";\n',
  "packages/ui/src/node.ts": 'import { readFileSync } from "fs";\n',
  "apps/web/src/node.ts": 'import { readFileSync } from "fs";\n',
  "packages/persistence/src/node.ts": 'import { readFileSync } from "node:fs";\n',
};

let dir;
let found;

before(() => {
  dir = mkdtempSync(join(tmpdir(), "hobbots-import-rules-"));
  copyFileSync(join(root, "biome.json"), join(dir, "biome.json"));
  for (const [file, source] of Object.entries(probes)) {
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    writeFileSync(join(dir, file), `${source}\nexport {};\n`);
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
  found = new Set(JSON.parse(output).diagnostics.map(({ location, category }) => `${location.path} ${category}`));
});

after(() => rmSync(dir, { recursive: true, force: true }));

const fails = (file, category) => assert.ok(found.has(`${file} ${category}`), `${file} should fail ${category}`);
const passes = (file, category) => assert.ok(!found.has(`${file} ${category}`), `${file} should pass ${category}`);

test("the domain may import effect and its own files", () => {
  passes("packages/domain/src/allowed.ts", "lint/style/noRestrictedImports");
});

test("the domain rejects any other package", () => {
  for (const file of ["package", "scoped", "subpath", "node"]) {
    fails(`packages/domain/src/${file}.ts`, "lint/style/noRestrictedImports");
  }
});

test("bare Node imports fail outside the adapters", () => {
  for (const file of ["packages/domain", "packages/agents", "packages/api", "packages/ui", "apps/web"]) {
    fails(`${file}/src/node.ts`, "lint/correctness/noNodejsModules");
  }
});

test("adapters may import Node modules", () => {
  passes("packages/persistence/src/node.ts", "lint/correctness/noNodejsModules");
});
