// Runs Biome with the repository's biome.json over probe files, to prove the layer import rules (STD-ARCH-001..004).

import { before, test } from "node:test";
import { lintProbes } from "./biome-probes.mjs";

const probes = {
  "packages/domain/src/allowed.ts": 'import { Schema } from "effect";\nimport { id } from "./id.ts";\n',
  "packages/domain/src/package.ts": 'import pg from "pg";\n',
  "packages/domain/src/scoped.ts": 'import { a } from "@scope/pkg";\n',
  "packages/domain/src/subpath.ts": 'import { Schema } from "effect/Schema";\n',
  "packages/domain/src/node.ts": 'import { readFileSync } from "fs";\n',
  "packages/agents/src/node.ts": 'import { readFileSync } from "fs";\n',
  "packages/orchestration/src/node.ts": 'import { readFileSync } from "fs";\n',
  "packages/api/src/node.ts": 'import { readFileSync } from "fs";\n',
  "packages/ui/src/node.ts": 'import { readFileSync } from "fs";\n',
  "apps/web/src/node.ts": 'import { readFileSync } from "fs";\n',
  "packages/persistence/src/node.ts": 'import { readFileSync } from "node:fs";\n',
};

let fails;
let passes;

before(() => {
  ({ fails, passes } = lintProbes(
    Object.fromEntries(Object.entries(probes).map(([file, source]) => [file, `${source}\nexport {};\n`])),
  ));
});

test("the domain may import effect and its own files", () => {
  passes("packages/domain/src/allowed.ts", "lint/style/noRestrictedImports");
});

test("the domain rejects any other package", () => {
  for (const file of ["package", "scoped", "subpath", "node"]) {
    fails(`packages/domain/src/${file}.ts`, "lint/style/noRestrictedImports");
  }
});

test("bare Node imports fail outside the adapters", () => {
  for (const file of [
    "packages/domain",
    "packages/agents",
    "packages/orchestration",
    "packages/api",
    "packages/ui",
    "apps/web",
  ]) {
    fails(`${file}/src/node.ts`, "lint/correctness/noNodejsModules");
  }
});

test("adapters may import Node modules", () => {
  passes("packages/persistence/src/node.ts", "lint/correctness/noNodejsModules");
});
