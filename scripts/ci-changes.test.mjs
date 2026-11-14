import assert from "node:assert/strict";
import { test } from "node:test";
import { suitesFor } from "./ci-changes.mjs";

test("a push to main and a merge queue's group run every suite", () => {
  for (const event of ["push", "merge_group", "workflow_dispatch"]) {
    assert.deepEqual(suitesFor(event, false, []), { database: true, browser: true });
  }
});

test("a draft pull request runs neither slower suite", () => {
  assert.deepEqual(suitesFor("pull_request", true, ["packages/persistence/src/x.ts"]), {
    database: false,
    browser: false,
  });
});

test("a pull request runs the suites its files reach", () => {
  assert.deepEqual(suitesFor("pull_request", false, ["packages/persistence/src/migrator.ts"]), {
    database: true,
    browser: false,
  });
  assert.deepEqual(suitesFor("pull_request", false, ["apps/web/src/app.tsx", "docs/STATUS.md"]), {
    database: false,
    browser: true,
  });
  assert.deepEqual(suitesFor("pull_request", false, ["packages/domain/src/events.ts"]), {
    database: false,
    browser: true,
  });
  assert.deepEqual(suitesFor("pull_request", false, ["packages/orchestration/src/x.ts", "docs/a.md"]), {
    database: false,
    browser: false,
  });
  assert.deepEqual(suitesFor("pull_request", false, ["pnpm-lock.yaml"]), { database: true, browser: true });
});
