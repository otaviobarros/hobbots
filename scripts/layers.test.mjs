import assert from "node:assert/strict";
import { test } from "node:test";
import { check } from "./layers.mjs";

const table = {
  "@hobbots/domain": { layer: "domain", may: [], external: ["effect"] },
  "@hobbots/api": { layer: "contract", may: ["@hobbots/domain"] },
};

const workspace = (domain = {}, api = {}) => ({
  "packages/domain": { name: "@hobbots/domain", dependencies: { effect: "catalog:" }, ...domain },
  "packages/api": { name: "@hobbots/api", dependencies: { "@hobbots/domain": "workspace:*" }, ...api },
});

test("allowed dependencies pass", () => {
  assert.deepEqual(check(workspace(), table), []);
});

test("a workspace dependency outside the layer's list fails", () => {
  const errors = check(workspace({ devDependencies: { "@hobbots/api": "workspace:*" } }), table);
  assert.deepEqual(errors, ["@hobbots/domain (domain) must not depend on @hobbots/api (contract)"]);
});

test("an external runtime dependency outside the domain's allowlist fails", () => {
  const errors = check(workspace({ dependencies: { effect: "catalog:", pg: "8.0.0" } }), table);
  assert.deepEqual(errors, ["@hobbots/domain (domain) must not depend on pg"]);
});

test("the domain may keep test tools as dev dependencies", () => {
  assert.deepEqual(check(workspace({ devDependencies: { vitest: "5.0.5" } }), table), []);
});

test("a package without a layer and a layer without a package both fail", () => {
  const packages = { ...workspace(), "packages/extra": { name: "@hobbots/extra" } };
  delete packages["packages/api"];
  assert.deepEqual(check(packages, table), [
    "@hobbots/extra (packages/extra) has no layer in scripts/layers.mjs",
    "@hobbots/api is listed in scripts/layers.mjs but no package has that name",
  ]);
});
